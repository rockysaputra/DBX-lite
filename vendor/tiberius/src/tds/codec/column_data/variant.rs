use std::{borrow::Cow, convert::TryFrom};

use byteorder::{ByteOrder, LittleEndian};
use futures_util::io::AsyncReadExt;
use uuid::Uuid;

#[cfg(feature = "tds73")]
use crate::tds::time::{Date, DateTime2, DateTimeOffset, Time};
use crate::{
    error::Error,
    sql_read_bytes::SqlReadBytes,
    tds::{codec::guid, Collation, Numeric},
    ColumnData, FixedLenType, VarLenType,
};

/// The largest value a `sql_variant` can carry, header and properties included.
const MAX_VARIANT_LEN: usize = 8016;

fn invalid(message: impl Into<Cow<'static, str>>) -> Error {
    Error::Protocol(message.into())
}

/// Decode a `sql_variant` value (MS-TDS 2.2.5.5.4) into the `ColumnData` of
/// its base type. A NULL variant carries no base type and is returned as a
/// NULL string.
pub(crate) async fn decode<R>(src: &mut R) -> crate::Result<ColumnData<'static>>
where
    R: SqlReadBytes + Unpin,
{
    let total_len = src.read_u32_le().await? as usize;

    if total_len == 0 {
        return Ok(ColumnData::String(None));
    }
    if !(2..=MAX_VARIANT_LEN).contains(&total_len) {
        return Err(invalid(format!(
            "sql_variant: length of {} is invalid",
            total_len
        )));
    }

    let base_type = src.read_u8().await?;
    let prop_len = src.read_u8().await? as usize;
    let data_len = total_len.checked_sub(2 + prop_len).ok_or_else(|| {
        invalid(format!(
            "sql_variant: {} property bytes do not fit in a value of {} bytes",
            prop_len, total_len
        ))
    })?;

    let mut props = vec![0u8; prop_len];
    src.read_exact(&mut props).await?;

    if let Ok(ty) = FixedLenType::try_from(base_type) {
        let expected = match ty {
            FixedLenType::Null => 0,
            FixedLenType::Int1 | FixedLenType::Bit => 1,
            FixedLenType::Int2 => 2,
            FixedLenType::Int4
            | FixedLenType::Datetime4
            | FixedLenType::Float4
            | FixedLenType::Money4 => 4,
            FixedLenType::Money
            | FixedLenType::Datetime
            | FixedLenType::Float8
            | FixedLenType::Int8 => 8,
        };
        if data_len != expected {
            return Err(invalid(format!(
                "sql_variant: {:?} value of {} bytes is invalid",
                ty, data_len
            )));
        }

        return super::fixed_len::decode(src, &ty).await;
    }

    let ty = VarLenType::try_from(base_type).map_err(|()| {
        invalid(format!(
            "sql_variant: invalid or unsupported base type {:#04x}",
            base_type
        ))
    })?;
    let expect_props = |expected: usize| {
        if props.len() == expected {
            Ok(())
        } else {
            Err(invalid(format!(
                "sql_variant: {:?} with {} property bytes is invalid",
                ty,
                props.len()
            )))
        }
    };

    let res = match ty {
        VarLenType::Guid => {
            expect_props(0)?;
            let mut data = <[u8; 16]>::try_from(read_data(src, data_len).await?)
                .map_err(|_| invalid(format!("guid: length of {} is invalid", data_len)))?;

            guid::reorder_bytes(&mut data);
            ColumnData::Guid(Some(Uuid::from_bytes(data)))
        }
        VarLenType::Decimaln | VarLenType::Numericn => {
            expect_props(2)?;
            let scale = props[1];
            let data = read_data(src, data_len).await?;

            ColumnData::Numeric(Some(decode_numeric(&data, scale)?))
        }
        VarLenType::BigVarBin | VarLenType::BigBinary => {
            expect_props(2)?;
            ColumnData::Binary(Some(Cow::Owned(read_data(src, data_len).await?)))
        }
        VarLenType::BigVarChar | VarLenType::BigChar => {
            expect_props(7)?;
            let collation = Collation::new(LittleEndian::read_u32(&props[0..4]), props[4]);
            let data = read_data(src, data_len).await?;
            // Lossy, as for regular varchar columns: a value holding bytes that
            // are invalid in its collation must stay readable.
            let (s, _) = collation.codec()?.decode_lossy(data.as_ref());

            ColumnData::String(Some(Cow::Owned(s.to_string())))
        }
        VarLenType::NVarchar | VarLenType::NChar => {
            expect_props(7)?;
            let data = read_data(src, data_len).await?;
            if data.len() % 2 != 0 {
                return Err(invalid("sql_variant: invalid nvarchar length"));
            }
            let buf: Vec<_> = data.chunks(2).map(LittleEndian::read_u16).collect();

            ColumnData::String(Some(Cow::Owned(String::from_utf16_lossy(&buf))))
        }
        #[cfg(feature = "tds73")]
        VarLenType::Daten => {
            expect_props(0)?;
            if data_len != 3 {
                return Err(invalid(format!(
                    "daten: length of {} is invalid",
                    data_len
                )));
            }

            ColumnData::Date(Some(Date::decode(src).await?))
        }
        #[cfg(feature = "tds73")]
        VarLenType::Timen => {
            expect_props(1)?;
            ColumnData::Time(Some(Time::decode(src, props[0] as usize, data_len).await?))
        }
        #[cfg(feature = "tds73")]
        VarLenType::Datetime2 => {
            expect_props(1)?;
            let time_len = temporal_time_len(data_len, 3)?;

            ColumnData::DateTime2(Some(
                DateTime2::decode(src, props[0] as usize, time_len).await?,
            ))
        }
        #[cfg(feature = "tds73")]
        VarLenType::DatetimeOffsetn => {
            expect_props(1)?;
            let time_len = temporal_time_len(data_len, 5)?;

            ColumnData::DateTimeOffset(Some(
                DateTimeOffset::decode(src, props[0] as usize, time_len as u8).await?,
            ))
        }
        ty => {
            return Err(invalid(format!(
                "sql_variant: base type {:?} is not supported",
                ty
            )))
        }
    };

    Ok(res)
}

async fn read_data<R>(src: &mut R, len: usize) -> crate::Result<Vec<u8>>
where
    R: SqlReadBytes + Unpin,
{
    let mut data = vec![0u8; len];
    src.read_exact(&mut data).await?;

    Ok(data)
}

#[cfg(feature = "tds73")]
fn temporal_time_len(data_len: usize, trailer_len: usize) -> crate::Result<usize> {
    data_len.checked_sub(trailer_len).ok_or_else(|| {
        invalid(format!(
            "sql_variant: temporal value of {} bytes is invalid",
            data_len
        ))
    })
}

/// A variant numeric is a sign byte followed by a little-endian magnitude of
/// 4, 8, 12 or 16 bytes, without the length prefix a numeric column has.
fn decode_numeric(data: &[u8], scale: u8) -> crate::Result<Numeric> {
    // `Numeric::new_with_scale` panics on a larger scale.
    if scale >= 38 {
        return Err(invalid(format!(
            "decimal/numeric: scale of {} is not supported",
            scale
        )));
    }

    let (sign, magnitude) = match data.split_first() {
        Some((0, magnitude)) => (-1i128, magnitude),
        Some((1, magnitude)) => (1i128, magnitude),
        _ => return Err(invalid("decimal: invalid sign")),
    };
    if !matches!(magnitude.len(), 4 | 8 | 12 | 16) {
        return Err(invalid(format!(
            "decimal/numeric: invalid length of {} received",
            data.len()
        )));
    }

    let mut bytes = [0u8; 16];
    bytes[..magnitude.len()].copy_from_slice(magnitude);
    let value = i128::try_from(u128::from_le_bytes(bytes))
        .map_err(|_| invalid("decimal/numeric: value out of range"))?;

    Ok(Numeric::new_with_scale(value * sign, scale))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sql_read_bytes::test_utils::IntoSqlReadBytes;
    use bytes::BytesMut;

    /// Frames a variant value: total length, base type, properties, data.
    fn variant(base_type: u8, props: &[u8], data: &[u8]) -> BytesMut {
        let mut buf = BytesMut::new();
        buf.extend_from_slice(&((2 + props.len() + data.len()) as u32).to_le_bytes());
        buf.extend_from_slice(&[base_type, props.len() as u8]);
        buf.extend_from_slice(props);
        buf.extend_from_slice(data);
        buf
    }

    async fn decode_bytes(buf: BytesMut) -> crate::Result<ColumnData<'static>> {
        decode(&mut buf.into_sql_read_bytes()).await
    }

    const COLLATION_AND_MAX_LEN: [u8; 7] = [0x09, 0x04, 0xD0, 0x00, 0x34, 0x40, 0x1F];

    #[tokio::test]
    async fn null_variant_is_a_null_value() {
        let mut buf = BytesMut::new();
        buf.extend_from_slice(&0u32.to_le_bytes());

        assert_eq!(decode_bytes(buf).await.unwrap(), ColumnData::String(None));
    }

    #[tokio::test]
    async fn int_variant_decodes_to_its_base_type() {
        // `sys.configurations.value_in_use` for an unlimited 'max server memory (MB)'.
        let buf = variant(0x38, &[], &2_147_483_647i32.to_le_bytes());

        assert_eq!(
            decode_bytes(buf).await.unwrap(),
            ColumnData::I32(Some(2_147_483_647))
        );
    }

    #[tokio::test]
    async fn nvarchar_variant_decodes_utf16() {
        let data: Vec<u8> = "héllo".encode_utf16().flat_map(u16::to_le_bytes).collect();
        let buf = variant(0xE7, &COLLATION_AND_MAX_LEN, &data);

        assert_eq!(
            decode_bytes(buf).await.unwrap(),
            ColumnData::String(Some("héllo".into()))
        );
    }

    #[tokio::test]
    async fn varchar_variant_decodes_with_its_collation() {
        let buf = variant(0xA7, &COLLATION_AND_MAX_LEN, b"abc");

        assert_eq!(
            decode_bytes(buf).await.unwrap(),
            ColumnData::String(Some("abc".into()))
        );
    }

    #[tokio::test]
    async fn numeric_variant_keeps_sign_and_scale() {
        let buf = variant(0x6C, &[10, 2], &[0, 0x39, 0x30, 0, 0]);

        assert_eq!(
            decode_bytes(buf).await.unwrap(),
            ColumnData::Numeric(Some(Numeric::new_with_scale(-12345, 2)))
        );
    }

    #[tokio::test]
    async fn varbinary_variant_decodes_raw_bytes() {
        let buf = variant(0xA5, &[0x40, 0x1F], &[0xDE, 0xAD]);

        assert_eq!(
            decode_bytes(buf).await.unwrap(),
            ColumnData::Binary(Some(vec![0xDE, 0xAD].into()))
        );
    }

    #[tokio::test]
    async fn guid_variant_decodes() {
        let buf = variant(0x24, &[], &[0u8; 16]);

        assert_eq!(
            decode_bytes(buf).await.unwrap(),
            ColumnData::Guid(Some(Uuid::nil()))
        );
    }

    #[cfg(feature = "tds73")]
    #[tokio::test]
    async fn datetime2_variant_decodes_time_then_date() {
        let buf = variant(0x2A, &[7], &[1, 0, 0, 0, 0, 2, 0, 0]);

        assert_eq!(
            decode_bytes(buf).await.unwrap(),
            ColumnData::DateTime2(Some(DateTime2::new(Date::new(2), Time::new(1, 7))))
        );
    }

    #[tokio::test]
    async fn value_left_after_a_variant_is_still_readable() {
        let mut buf = variant(0x38, &[], &7i32.to_le_bytes());
        buf.extend_from_slice(&[0xAB]);
        let mut src = buf.into_sql_read_bytes();

        assert_eq!(decode(&mut src).await.unwrap(), ColumnData::I32(Some(7)));
        assert_eq!(src.read_u8().await.unwrap(), 0xAB);
    }

    #[tokio::test]
    async fn unsupported_base_type_is_an_error() {
        let buf = variant(0xF1, &[], &[]);

        assert!(matches!(decode_bytes(buf).await, Err(Error::Protocol(_))));
    }

    #[tokio::test]
    async fn properties_longer_than_the_value_are_an_error() {
        let mut buf = BytesMut::new();
        buf.extend_from_slice(&3u32.to_le_bytes());
        buf.extend_from_slice(&[0xE7, 7, 0]);

        assert!(matches!(decode_bytes(buf).await, Err(Error::Protocol(_))));
    }

    #[tokio::test]
    async fn fixed_type_with_wrong_data_length_is_an_error() {
        let buf = variant(0x38, &[], &[1, 2]);

        assert!(matches!(decode_bytes(buf).await, Err(Error::Protocol(_))));
    }
}
