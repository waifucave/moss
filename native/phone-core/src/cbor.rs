//! The link's CBOR, as the engine's `links/codec.ts` writes and reads it, for what pairing and the link protocol carry:
//! integers (the shortest head; past 2^32 an 8-byte head), byte and text strings, arrays, text-keyed maps in the order
//! written, booleans, null, undefined and float64. The transcripts both sides hash are these bytes, so the encoder
//! must match the engine's byte for byte (held by `tests/vectors.rs`). The decoder refuses what the engine's refuses:
//! indefinite lengths, nesting past 128, lengths past the payload, non-text map keys, unknown simple values and bytes
//! left over. Tags (the engine's dates, bignums, maps, sets and typed arrays) never appear in what a phone reads and
//! are refused.
//!
//! What a computer sends is bounded before it costs anything: a cap on the items in one value (every array element
//! and map entry counted) and on its nesting, repeated map keys found in linear time, and nothing allocated from a
//! length on the wire beyond what the payload still holds.

use crate::error::CoreError;

pub const MAX_DEPTH: usize = 128;

/// What one decoded value may hold.
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    /// Array elements and map entries, counted across the whole value.
    pub max_items: usize,
    pub max_depth: usize,
}

/// A pairing message or a link lane's message: a few hundred items at most in anything the engine sends.
pub const LANE_LIMITS: Limits = Limits { max_items: 4096, max_depth: 32 };

#[derive(Clone, Debug, PartialEq)]
pub enum Cbor {
    /// A non-negative integer (major 0).
    Uint(u64),
    /// A negative integer -1 - n (major 1).
    Nint(u64),
    Bytes(Vec<u8>),
    Text(String),
    Array(Vec<Cbor>),
    /// A plain object: text keys, in the order written.
    Map(Vec<(String, Cbor)>),
    Bool(bool),
    Null,
    Undefined,
    Float(f64),
}

impl Cbor {
    pub fn text(s: impl Into<String>) -> Self {
        Cbor::Text(s.into())
    }
    pub fn bytes(b: impl AsRef<[u8]>) -> Self {
        Cbor::Bytes(b.as_ref().to_vec())
    }
    /// A JS number as the engine encodes it: a safe integer as an integer, anything else as float64.
    pub fn number(n: f64) -> Self {
        const SAFE: f64 = 9_007_199_254_740_991.0;
        if n.fract() == 0.0 && n.abs() <= SAFE && !(n == 0.0 && n.is_sign_negative()) {
            if n >= 0.0 {
                Cbor::Uint(n as u64)
            } else {
                Cbor::Nint((-1.0 - n) as u64)
            }
        } else {
            Cbor::Float(n)
        }
    }
    pub fn int(n: i64) -> Self {
        if n >= 0 {
            Cbor::Uint(n as u64)
        } else {
            Cbor::Nint((-1 - n) as u64)
        }
    }
    pub fn opt_text(s: Option<&str>) -> Self {
        s.map(Cbor::text).unwrap_or(Cbor::Null)
    }
    pub fn map(entries: Vec<(&str, Cbor)>) -> Self {
        Cbor::Map(entries.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
    }

    pub fn get(&self, key: &str) -> Option<&Cbor> {
        match self {
            Cbor::Map(m) => m.iter().rev().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Cbor::Text(s) => Some(s),
            _ => None,
        }
    }
    pub fn as_bytes(&self) -> Option<&[u8]> {
        match self {
            Cbor::Bytes(b) => Some(b),
            _ => None,
        }
    }
    pub fn as_array(&self) -> Option<&[Cbor]> {
        match self {
            Cbor::Array(a) => Some(a),
            _ => None,
        }
    }
    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Cbor::Bool(b) => Some(*b),
            _ => None,
        }
    }
    /// The value as a JS number, when it is one.
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Cbor::Uint(n) => Some(*n as f64),
            Cbor::Nint(n) => Some(-1.0 - *n as f64),
            Cbor::Float(f) => Some(*f),
            _ => None,
        }
    }
    pub fn is_null(&self) -> bool {
        matches!(self, Cbor::Null)
    }
}

pub fn encode(v: &Cbor) -> Vec<u8> {
    let mut out = Vec::with_capacity(256);
    write(&mut out, v);
    out
}

fn head(out: &mut Vec<u8>, major: u8, n: u64) {
    let m = major << 5;
    if n < 24 {
        out.push(m | n as u8);
    } else if n < 0x100 {
        out.push(m | 24);
        out.push(n as u8);
    } else if n < 0x1_0000 {
        out.push(m | 25);
        out.extend_from_slice(&(n as u16).to_be_bytes());
    } else if n < 0x1_0000_0000 {
        out.push(m | 26);
        out.extend_from_slice(&(n as u32).to_be_bytes());
    } else {
        out.push(m | 27);
        out.extend_from_slice(&n.to_be_bytes());
    }
}

fn write(out: &mut Vec<u8>, v: &Cbor) {
    match v {
        Cbor::Uint(n) => head(out, 0, *n),
        Cbor::Nint(n) => head(out, 1, *n),
        Cbor::Bytes(b) => {
            head(out, 2, b.len() as u64);
            out.extend_from_slice(b);
        }
        Cbor::Text(s) => {
            head(out, 3, s.len() as u64);
            out.extend_from_slice(s.as_bytes());
        }
        Cbor::Array(a) => {
            head(out, 4, a.len() as u64);
            for x in a {
                write(out, x);
            }
        }
        Cbor::Map(m) => {
            head(out, 5, m.len() as u64);
            for (k, x) in m {
                write(out, &Cbor::Text(k.clone()));
                write(out, x);
            }
        }
        Cbor::Bool(b) => out.push(if *b { 0xf5 } else { 0xf4 }),
        Cbor::Null => out.push(0xf6),
        Cbor::Undefined => out.push(0xf7),
        Cbor::Float(f) => {
            out.push(0xfb);
            out.extend_from_slice(&f.to_be_bytes());
        }
    }
}

struct Reader<'a> {
    b: &'a [u8],
    at: usize,
    items: usize,
    limits: Limits,
}

fn bad(why: &str) -> CoreError {
    CoreError::Protocol { reason: format!("malformed CBOR: {why}") }
}

impl<'a> Reader<'a> {
    fn left(&self) -> usize {
        self.b.len() - self.at
    }
    fn take(&mut self, n: usize) -> Result<&'a [u8], CoreError> {
        if n > self.left() {
            return Err(bad("cut short"));
        }
        let s = &self.b[self.at..self.at + n];
        self.at += n;
        Ok(s)
    }
    fn u8(&mut self) -> Result<u8, CoreError> {
        Ok(self.take(1)?[0])
    }
    fn arg(&mut self, info: u8) -> Result<u64, CoreError> {
        Ok(match info {
            0..=23 => info as u64,
            24 => self.u8()? as u64,
            25 => u16::from_be_bytes(self.take(2)?.try_into().unwrap()) as u64,
            26 => u32::from_be_bytes(self.take(4)?.try_into().unwrap()) as u64,
            27 => u64::from_be_bytes(self.take(8)?.try_into().unwrap()),
            _ => return Err(bad("indefinite lengths aren't accepted")),
        })
    }
    fn len(&mut self, info: u8, min_each: u64) -> Result<usize, CoreError> {
        let n = self.arg(info)?;
        if n.checked_mul(min_each).map_or(true, |t| t > self.left() as u64) {
            return Err(bad("a length runs past the payload"));
        }
        Ok(n as usize)
    }
    fn count(&mut self, n: usize) -> Result<(), CoreError> {
        self.items = self.items.saturating_add(n);
        if self.items > self.limits.max_items {
            return Err(bad("too many items"));
        }
        Ok(())
    }
    fn value(&mut self, depth: usize) -> Result<Cbor, CoreError> {
        if depth > MAX_DEPTH.min(self.limits.max_depth) {
            return Err(bad("nested too deeply"));
        }
        let first = self.u8()?;
        let (major, info) = (first >> 5, first & 31);
        Ok(match major {
            0 => Cbor::Uint(self.arg(info)?),
            1 => Cbor::Nint(self.arg(info)?),
            2 => {
                let n = self.len(info, 1)?;
                Cbor::Bytes(self.take(n)?.to_vec())
            }
            3 => {
                let n = self.len(info, 1)?;
                Cbor::Text(String::from_utf8(self.take(n)?.to_vec()).map_err(|_| bad("text isn't UTF-8"))?)
            }
            4 => {
                let n = self.len(info, 1)?;
                self.count(n)?;
                // `len` held n to what the payload still has, and `count` to the item cap.
                let mut a = Vec::with_capacity(n);
                for _ in 0..n {
                    a.push(self.value(depth + 1)?);
                }
                Cbor::Array(a)
            }
            5 => {
                let n = self.len(info, 2)?;
                self.count(n)?;
                let mut m: Vec<(String, Cbor)> = Vec::with_capacity(n);
                let mut at: std::collections::HashMap<String, usize> = std::collections::HashMap::with_capacity(n);
                for _ in 0..n {
                    let Cbor::Text(k) = self.value(depth + 1)? else { return Err(bad("an object key must be text")) };
                    let v = self.value(depth + 1)?;
                    // A repeated key replaces the earlier one, as the engine's decoder does.
                    match at.get(&k) {
                        Some(&i) => m[i].1 = v,
                        None => {
                            at.insert(k.clone(), m.len());
                            m.push((k, v));
                        }
                    }
                }
                Cbor::Map(m)
            }
            6 => return Err(bad("tags aren't accepted here")),
            _ => match info {
                20 => Cbor::Bool(false),
                21 => Cbor::Bool(true),
                22 => Cbor::Null,
                23 => Cbor::Undefined,
                25 => Cbor::Float(f16(u16::from_be_bytes(self.take(2)?.try_into().unwrap()))),
                26 => Cbor::Float(f32::from_be_bytes(self.take(4)?.try_into().unwrap()) as f64),
                27 => Cbor::Float(f64::from_be_bytes(self.take(8)?.try_into().unwrap())),
                _ => return Err(bad("an unknown simple value")),
            },
        })
    }
}

fn f16(h: u16) -> f64 {
    let exp = (h >> 10) & 0x1f;
    let mant = (h & 0x3ff) as f64;
    let sign = if h & 0x8000 != 0 { -1.0 } else { 1.0 };
    match exp {
        0 => sign * 2f64.powi(-14) * (mant / 1024.0),
        31 => {
            if mant != 0.0 {
                f64::NAN
            } else {
                sign * f64::INFINITY
            }
        }
        e => sign * 2f64.powi(e as i32 - 15) * (1.0 + mant / 1024.0),
    }
}

pub fn decode(bytes: &[u8]) -> Result<Cbor, CoreError> {
    decode_with(bytes, LANE_LIMITS)
}

pub fn decode_with(bytes: &[u8], limits: Limits) -> Result<Cbor, CoreError> {
    let mut r = Reader { b: bytes, at: 0, items: 0, limits };
    let v = r.value(0)?;
    if r.left() != 0 {
        return Err(bad("bytes left over"));
    }
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn heads_and_round_trip() {
        assert_eq!(encode(&Cbor::Uint(23)), [0x17]);
        assert_eq!(encode(&Cbor::Uint(24)), [0x18, 24]);
        assert_eq!(encode(&Cbor::Uint(0x1_0000_0000)), [0x1b, 0, 0, 0, 1, 0, 0, 0, 0]);
        assert_eq!(encode(&Cbor::number(-1.0)), [0x20]);
        assert_eq!(encode(&Cbor::number(1.5)), [0xfb, 0x3f, 0xf8, 0, 0, 0, 0, 0, 0]);
        assert_eq!(encode(&Cbor::number(-0.0))[0], 0xfb);
        let v = Cbor::Array(vec![Cbor::text("a"), Cbor::map(vec![("k", Cbor::bytes([1, 2])), ("n", Cbor::Null)])]);
        assert_eq!(decode(&encode(&v)).unwrap(), v);
    }

    #[test]
    fn refusals() {
        assert!(decode(&[0x9f]).is_err()); // indefinite array
        assert!(decode(&[0x01, 0x02]).is_err()); // left over
        assert!(decode(&[0x5a, 0xff, 0xff, 0xff, 0xff]).is_err()); // length past the payload
        assert!(decode(&[0xa1, 0x01, 0x01]).is_err()); // non-text key
        assert!(decode(&[0xc1, 0x01]).is_err()); // a tag
        let mut deep = vec![0x81; 200];
        deep.push(0x00);
        assert!(decode(&deep).is_err());
    }

    /// A 16 MiB frame of 2.8 million distinct map keys: refused at the item cap at once, never a quadratic scan.
    #[test]
    fn a_huge_map_is_refused_fast() {
        let n: u32 = 2_800_000;
        let mut b = vec![0xba];
        b.extend_from_slice(&n.to_be_bytes());
        for i in 0..n {
            b.push(0x64);
            b.extend_from_slice(&i.to_be_bytes());
            b.push(0xf6);
        }
        let t = std::time::Instant::now();
        assert!(decode(&b).is_err());
        assert!(t.elapsed() < std::time::Duration::from_millis(500), "took {:?}", t.elapsed());
        // Under the cap, repeated keys are still linear: 4000 entries of one key decode at once, the last one kept.
        let mut d = vec![0xb9, 0x0f, 0xa0];
        for i in 0..4000u16 {
            d.extend_from_slice(&[0x61, b'k', 0x19]);
            d.extend_from_slice(&i.to_be_bytes());
        }
        assert_eq!(decode(&d).unwrap(), Cbor::map(vec![("k", Cbor::Uint(3999))]));
    }
}
