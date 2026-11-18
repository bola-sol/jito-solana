//! The published feed on disk, so the page can rewind past what it has held itself. A segment opens
//! with a joining client's snapshot, then every message as `<ms> <json>` lines in zstd blocks, each
//! behind a skippable frame holding its header so `zstd -dc` reads the file whole.

use {
    crate::proto::{Message, Publisher},
    std::{
        fs::{self, File, OpenOptions},
        io::{self, Read, Seek, SeekFrom, Write},
        path::{Path, PathBuf},
        sync::{
            Arc, RwLock,
            atomic::{AtomicBool, Ordering},
        },
        thread,
        time::Duration,
    },
    tokio::sync::broadcast::{Receiver, error::TryRecvError},
};

/// Raised by hand when what a segment holds changes shape; older files are not offered and age out.
pub const FORMAT: u32 = 1;

const SUFFIX: &str = ".rewind.zst";

const SKIPPABLE_MAGIC: u32 = 0x184D_2A50;

/// Format, keyframe flag, raw length, compressed length, first and last time.
const HEADER_PAYLOAD: usize = 29;

const HEADER_LEN: usize = 8 + HEADER_PAYLOAD;

/// The decoder refuses a block claiming more than this.
const MAX_BLOCK_RAW: usize = 4 * 1024 * 1024;

const LEVEL: i32 = 3;

const POLL: Duration = Duration::from_millis(20);

/// After a file could not be created or written, the wait before trying again, doubling to the most.
const RETRY_MIN_MS: u64 = 1_000;
const RETRY_MAX_MS: u64 = 60_000;

#[derive(Clone, Copy, Debug)]
pub struct Settings {
    pub segment_ms: u64,
    pub block_raw: usize,
    pub block_ms: u64,
    pub retain_ms: u64,
    pub cap_bytes: u64,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            segment_ms: 10 * 60_000,
            block_raw: 768 * 1024,
            block_ms: 30_000,
            retain_ms: 48 * 3_600_000,
            cap_bytes: 2 * 1024 * 1024 * 1024,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct BlockIndex {
    offset: u64,
    compressed: u32,
    raw: u32,
    first: u64,
    last: u64,
    keyframe: bool,
}

#[derive(Clone, Debug)]
struct SegmentIndex {
    start: u64,
    path: PathBuf,
    blocks: Vec<BlockIndex>,
}

impl SegmentIndex {
    fn end(&self) -> u64 {
        self.blocks.last().map_or(self.start, |block| block.last)
    }
}

/// One decoded block.
pub struct Block {
    pub keyframe: bool,
    pub first: u64,
    pub last: u64,
    /// `<ms> <json>` lines.
    pub text: String,
}

/// What is on disk, shared by the recorder that appends and the server that reads.
pub struct RewindLog {
    dir: PathBuf,
    segments: RwLock<Vec<SegmentIndex>>,
}

impl RewindLog {
    /// Creates the directory if needed and indexes the segments already in it.
    pub fn open(dir: impl Into<PathBuf>) -> io::Result<Self> {
        let dir = dir.into();
        fs::create_dir_all(&dir)?;
        let mut segments = Vec::new();
        for (start, path) in segment_files(&dir)? {
            if let Some(blocks) = scan(&path)
                && !blocks.is_empty()
            {
                segments.push(SegmentIndex {
                    start,
                    path,
                    blocks,
                });
            }
        }
        segments.sort_by_key(|segment| segment.start);
        Ok(Self {
            dir,
            segments: RwLock::new(segments),
        })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Start, end and block count of every segment holding at least one block, oldest first.
    pub fn range(&self) -> Vec<(u64, u64, usize)> {
        self.segments
            .read()
            .map(|segments| {
                segments
                    .iter()
                    .filter(|segment| !segment.blocks.is_empty())
                    .map(|segment| (segment.start, segment.end(), segment.blocks.len()))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Looked up by the segment's start and the block's place, so nothing a client sends becomes a
    /// path or an offset.
    pub fn read(&self, segment: u64, block: usize) -> Option<Block> {
        let (path, index) = {
            let segments = self.segments.read().ok()?;
            let found = segments.iter().find(|held| held.start == segment)?;
            (found.path.clone(), *found.blocks.get(block)?)
        };
        let mut file = File::open(path).ok()?;
        file.seek(SeekFrom::Start(index.offset)).ok()?;
        let mut compressed = vec![0u8; usize::try_from(index.compressed).ok()?];
        file.read_exact(&mut compressed).ok()?;
        let raw = usize::try_from(index.raw).ok()?;
        if raw > MAX_BLOCK_RAW {
            return None;
        }
        let bytes = zstd::bulk::decompress(&compressed, raw).ok()?;
        Some(Block {
            keyframe: index.keyframe,
            first: index.first,
            last: index.last,
            text: String::from_utf8(bytes).ok()?,
        })
    }

    /// Kept in order of start, which a clock stepped back across a restart would otherwise break.
    fn begin(&self, start: u64, path: PathBuf) {
        if let Ok(mut segments) = self.segments.write() {
            let at = segments.partition_point(|held| held.start < start);
            segments.insert(
                at,
                SegmentIndex {
                    start,
                    path,
                    blocks: Vec::new(),
                },
            );
        }
    }

    fn add_block(&self, start: u64, block: BlockIndex) {
        if let Ok(mut segments) = self.segments.write()
            && let Some(segment) = segments.iter_mut().rev().find(|held| held.start == start)
        {
            segment.blocks.push(block);
        }
    }

    fn forget(&self, start: u64) {
        if let Ok(mut segments) = self.segments.write() {
            segments.retain(|held| held.start != start);
        }
    }

    /// Deletes our own files past the retention, then the oldest while over the cap, sparing `keep`.
    fn prune(&self, now: u64, settings: &Settings, keep: Option<u64>) {
        let Ok(files) = segment_files(&self.dir) else {
            return;
        };
        let oldest_kept =
            now.saturating_sub(settings.retain_ms.saturating_add(settings.segment_ms));
        let mut sized = Vec::new();
        for (start, path) in files {
            if Some(start) == keep {
                sized.push((start, path, 0));
                continue;
            }
            if start < oldest_kept {
                self.remove(start, &path);
                continue;
            }
            let length = fs::metadata(&path).map_or(0, |meta| meta.len());
            sized.push((start, path, length));
        }
        let mut total = sized
            .iter()
            .fold(0u64, |sum, (_, _, length)| sum.saturating_add(*length));
        for (start, path, length) in sized {
            if total <= settings.cap_bytes {
                break;
            }
            if Some(start) == keep {
                continue;
            }
            self.remove(start, &path);
            total = total.saturating_sub(length);
        }
    }

    fn remove(&self, start: u64, path: &Path) {
        self.forget(start);
        if let Err(err) = fs::remove_file(path) {
            log::warn!("dashboard: could not delete {}: {err}", path.display());
        }
    }
}

/// Our segment files in `dir`, by start; anything else is left alone.
fn segment_files(dir: &Path) -> io::Result<Vec<(u64, PathBuf)>> {
    let mut files = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(start) = name.to_str().and_then(segment_start) else {
            continue;
        };
        if entry.file_type()?.is_file() {
            files.push((start, entry.path()));
        }
    }
    files.sort_by_key(|(start, _)| *start);
    Ok(files)
}

fn segment_start(name: &str) -> Option<u64> {
    let digits = name.strip_suffix(SUFFIX)?;
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

fn segment_name(start: u64) -> String {
    format!("{start}{SUFFIX}")
}

fn encode_header(block: &BlockIndex) -> [u8; HEADER_LEN] {
    let mut header = [0u8; HEADER_LEN];
    let size = u32::try_from(HEADER_PAYLOAD).unwrap_or(u32::MAX);
    let fields = [
        &SKIPPABLE_MAGIC.to_le_bytes()[..],
        &size.to_le_bytes(),
        &FORMAT.to_le_bytes(),
        &[u8::from(block.keyframe)],
        &block.raw.to_le_bytes(),
        &block.compressed.to_le_bytes(),
        &block.first.to_le_bytes(),
        &block.last.to_le_bytes(),
    ];
    let mut at = 0usize;
    for field in fields {
        let end = at.saturating_add(field.len());
        if let Some(slot) = header.get_mut(at..end) {
            slot.copy_from_slice(field);
        }
        at = end;
    }
    header
}

/// The header's fields, or None for anything that is not a header of this format.
fn decode_header(header: &[u8; HEADER_LEN], offset: u64) -> Option<BlockIndex> {
    let u32_at = |at: usize| {
        header
            .get(at..at.saturating_add(4))
            .and_then(|bytes| bytes.try_into().ok())
            .map(u32::from_le_bytes)
    };
    let u64_at = |at: usize| {
        header
            .get(at..at.saturating_add(8))
            .and_then(|bytes| bytes.try_into().ok())
            .map(u64::from_le_bytes)
    };
    if u32_at(0)? != SKIPPABLE_MAGIC
        || usize::try_from(u32_at(4)?).ok()? != HEADER_PAYLOAD
        || u32_at(8)? != FORMAT
    {
        return None;
    }
    Some(BlockIndex {
        offset: offset.saturating_add(u64::try_from(HEADER_LEN).ok()?),
        keyframe: *header.get(12)? != 0,
        raw: u32_at(13)?,
        compressed: u32_at(17)?,
        first: u64_at(21)?,
        last: u64_at(29)?,
    })
}

/// The blocks of a file, stopping at the first short or foreign one so a tail cut off by a crash is
/// ignored; None for a file of another format.
fn scan(path: &Path) -> Option<Vec<BlockIndex>> {
    let mut file = File::open(path).ok()?;
    let length = file.metadata().ok()?.len();
    let mut blocks = Vec::new();
    let mut offset = 0u64;
    loop {
        let mut header = [0u8; HEADER_LEN];
        if file.read_exact(&mut header).is_err() {
            break;
        }
        let Some(block) = decode_header(&header, offset) else {
            if blocks.is_empty() {
                return None;
            }
            break;
        };
        let end = block.offset.saturating_add(u64::from(block.compressed));
        if end > length {
            break;
        }
        if file.seek(SeekFrom::Start(end)).is_err() {
            break;
        }
        blocks.push(block);
        offset = end;
    }
    Some(blocks)
}

/// The segment being written.
struct Open {
    start: u64,
    path: PathBuf,
    blocks: usize,
    file: File,
    offset: u64,
    text: String,
    first: u64,
    last: u64,
    keyframe: bool,
}

/// Appends the feed to the log on its own thread; the collector only does the broadcast send it
/// does anyway.
pub struct Recorder {
    log: Arc<RewindLog>,
    publisher: Arc<Publisher>,
    updates: Receiver<Message>,
    settings: Settings,
    clock: Box<dyn FnMut() -> u64 + Send>,
    now: u64,
    open: Option<Open>,
    /// No new segment before this, after a failure.
    retry_at: u64,
    retry_ms: u64,
    /// Cleared once a block is written, so the next trouble is logged again.
    warned: bool,
}

impl Recorder {
    /// Subscribes before the first snapshot, as a joining client does.
    pub fn new(
        log: Arc<RewindLog>,
        publisher: Arc<Publisher>,
        settings: Settings,
        clock: Box<dyn FnMut() -> u64 + Send>,
    ) -> Self {
        let updates = publisher.subscribe();
        Self {
            log,
            publisher,
            updates,
            settings,
            clock,
            now: 0,
            open: None,
            retry_at: 0,
            retry_ms: RETRY_MIN_MS,
            warned: false,
        }
    }

    pub fn run(mut self, exit: &AtomicBool) {
        while !exit.load(Ordering::Relaxed) {
            if !self.step() {
                thread::sleep(POLL);
            }
        }
        self.close();
    }

    /// Takes what is queued; false when nothing was.
    pub fn step(&mut self) -> bool {
        self.tick();
        self.reopen();
        let mut took = false;
        loop {
            match self.updates.try_recv() {
                Ok(message) => {
                    took = true;
                    self.tick();
                    if self.due_to_rotate() {
                        self.rotate(Some(message));
                    } else {
                        self.append(&message);
                    }
                }
                Err(TryRecvError::Empty) | Err(TryRecvError::Closed) => break,
                Err(TryRecvError::Lagged(skipped)) => {
                    self.trouble(&format!("fell {skipped} messages behind"));
                    self.close();
                    // What is still queued is older than the snapshot the next segment opens with.
                    while let Ok(_) | Err(TryRecvError::Lagged(_)) = self.updates.try_recv() {}
                    self.reopen();
                }
            }
        }
        if !took && self.due_to_rotate() {
            self.rotate(None);
        }
        let stale = self.open.as_ref().is_some_and(|open| {
            !open.text.is_empty() && self.now.saturating_sub(open.first) >= self.settings.block_ms
        });
        if stale {
            self.flush();
        }
        took
    }

    /// Never goes back, so arrival times stay in order across a clock step.
    fn tick(&mut self) {
        self.now = self.now.max((self.clock)());
    }

    fn due_to_rotate(&self) -> bool {
        self.open
            .as_ref()
            .is_some_and(|open| self.now.saturating_sub(open.start) >= self.settings.segment_ms)
    }

    /// The old segment takes what was queued for it, then the new one opens on a fresh snapshot.
    fn rotate(&mut self, arrived: Option<Message>) {
        if let Some(message) = arrived {
            self.append(&message);
        }
        loop {
            match self.updates.try_recv() {
                Ok(message) => self.append(&message),
                Err(TryRecvError::Lagged(skipped)) => {
                    self.trouble(&format!("fell {skipped} messages behind"));
                }
                Err(TryRecvError::Empty) | Err(TryRecvError::Closed) => break,
            }
        }
        self.close();
        self.reopen();
    }

    /// Opens a segment unless one is open or the wait after a failure has not passed.
    fn reopen(&mut self) {
        if self.open.is_none() && self.now >= self.retry_at {
            self.begin();
        }
    }

    fn failed(&mut self) {
        self.retry_at = self.now.saturating_add(self.retry_ms);
        self.retry_ms = self.retry_ms.saturating_mul(2).min(RETRY_MAX_MS);
    }

    fn begin(&mut self) {
        let start = self.now;
        let path = self.log.dir.join(segment_name(start));
        let file = match OpenOptions::new().create_new(true).write(true).open(&path) {
            Ok(file) => file,
            Err(err) => {
                self.trouble(&format!("could not create {}: {err}", path.display()));
                self.failed();
                return;
            }
        };
        self.log.begin(start, path.clone());
        self.open = Some(Open {
            start,
            path,
            blocks: 0,
            file,
            offset: 0,
            text: String::new(),
            first: start,
            last: start,
            keyframe: true,
        });
        // A fresh slot overview follows, as it does for a client joining now.
        self.publisher.note_join();
        for message in self.publisher.snapshot() {
            self.push(start, message.text());
        }
        self.flush();
        if let Some(open) = self.open.as_mut() {
            open.keyframe = false;
        }
        self.log.prune(start, &self.settings, Some(start));
    }

    fn append(&mut self, message: &Message) {
        let now = self.now;
        self.push(now, message.text());
    }

    fn push(&mut self, at: u64, json: &str) {
        let line_len = json.len().saturating_add(22);
        let full = self.open.as_ref().is_some_and(|open| {
            !open.text.is_empty()
                && open.text.len().saturating_add(line_len) > self.settings.block_raw
        });
        if full {
            self.flush();
        }
        let Some(open) = self.open.as_mut() else {
            return;
        };
        if open.text.is_empty() {
            open.first = at;
        }
        open.last = at;
        open.text.push_str(&at.to_string());
        open.text.push(' ');
        open.text.push_str(json);
        open.text.push('\n');
    }

    /// Writes the pending block; a write that fails closes the segment so the next opens afresh.
    fn flush(&mut self) {
        let Some(open) = self.open.as_mut() else {
            return;
        };
        if open.text.is_empty() {
            return;
        }
        let text = std::mem::take(&mut open.text);
        let written = (|| -> io::Result<BlockIndex> {
            let compressed = zstd::bulk::compress(text.as_bytes(), LEVEL)?;
            let too_big = || io::Error::new(io::ErrorKind::InvalidData, "block too large");
            let block = BlockIndex {
                offset: open
                    .offset
                    .saturating_add(u64::try_from(HEADER_LEN).map_err(|_| too_big())?),
                compressed: u32::try_from(compressed.len()).map_err(|_| too_big())?,
                raw: u32::try_from(text.len()).map_err(|_| too_big())?,
                first: open.first,
                last: open.last,
                keyframe: open.keyframe,
            };
            open.file.write_all(&encode_header(&block))?;
            open.file.write_all(&compressed)?;
            open.offset = block.offset.saturating_add(u64::from(block.compressed));
            Ok(block)
        })();
        match written {
            Ok(block) => {
                open.blocks = open.blocks.saturating_add(1);
                let start = open.start;
                self.log.add_block(start, block);
                self.warned = false;
                self.retry_ms = RETRY_MIN_MS;
            }
            Err(err) => {
                // A file holding no block is no use to a reader, and a full disk would gather them.
                if open.blocks == 0 {
                    let (start, path) = (open.start, open.path.clone());
                    self.log.remove(start, &path);
                }
                self.open = None;
                self.trouble(&format!("could not write a block: {err}"));
                self.failed();
            }
        }
    }

    pub fn close(&mut self) {
        self.flush();
        self.open = None;
    }

    /// Logged once until a block is written again, so a full disk does not fill the log as well.
    fn trouble(&mut self, what: &str) {
        if !self.warned {
            log::warn!("dashboard: rewind log {what}");
            self.warned = true;
        }
    }
}

#[cfg(test)]
mod tests {
    use {
        super::*,
        crate::proto::TOPIC_SUMMARY,
        std::sync::{Mutex, atomic::AtomicU64},
    };

    fn settings() -> Settings {
        Settings {
            segment_ms: 60_000,
            block_raw: 4096,
            block_ms: 5_000,
            retain_ms: 600_000,
            cap_bytes: u64::MAX,
        }
    }

    /// A recorder on a clock the test moves.
    fn recorder(dir: &Path, settings: Settings) -> (Recorder, Arc<Publisher>, Arc<AtomicU64>) {
        let log = Arc::new(RewindLog::open(dir).unwrap());
        let publisher = Arc::new(Publisher::new());
        let now = Arc::new(AtomicU64::new(1_000_000));
        let clock = now.clone();
        let recorder = Recorder::new(
            log,
            publisher.clone(),
            settings,
            Box::new(move || clock.load(Ordering::Relaxed)),
        );
        (recorder, publisher, now)
    }

    fn lines(log: &RewindLog, segment: u64) -> Vec<String> {
        let blocks = log
            .range()
            .into_iter()
            .find(|(start, _, _)| *start == segment)
            .map_or(0, |(_, _, blocks)| blocks);
        (0..blocks)
            .flat_map(|block| {
                log.read(segment, block)
                    .unwrap()
                    .text
                    .lines()
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            })
            .collect()
    }

    #[test]
    fn test_a_segment_opens_with_the_snapshot_then_holds_what_follows() {
        let dir = tempfile::tempdir().unwrap();
        let (mut recorder, publisher, now) = recorder(dir.path(), settings());
        publisher.publish(TOPIC_SUMMARY, "cluster", &"testnet");
        recorder.step();
        now.store(1_002_000, Ordering::Relaxed);
        publisher.publish(TOPIC_SUMMARY, "root_slot", &7u64);
        recorder.step();
        recorder.close();

        let log = RewindLog::open(dir.path()).unwrap();
        let range = log.range();
        assert_eq!(range.len(), 1);
        let (start, end, blocks) = range[0];
        assert_eq!((start, end, blocks), (1_000_000, 1_002_000, 2));
        assert!(log.read(start, 0).unwrap().keyframe);
        assert!(!log.read(start, 1).unwrap().keyframe);
        // Published after the recorder subscribed, so in the snapshot and queued too, as for a client.
        assert_eq!(
            lines(&log, start),
            [
                r#"1000000 {"topic":"summary","key":"cluster","value":"testnet"}"#,
                r#"1000000 {"topic":"summary","key":"cluster","value":"testnet"}"#,
                r#"1002000 {"topic":"summary","key":"root_slot","value":7}"#,
            ]
        );
    }

    #[test]
    fn test_what_is_recorded_is_what_a_joining_subscriber_receives() {
        let dir = tempfile::tempdir().unwrap();
        let (mut recorder, publisher, _now) = recorder(dir.path(), settings());
        let mut client = publisher.subscribe();
        publisher.publish(TOPIC_SUMMARY, "a", &1u64);
        let mut seen: Vec<String> = publisher
            .snapshot()
            .iter()
            .map(|message| message.text().to_owned())
            .collect();
        recorder.step();
        publisher.publish(TOPIC_SUMMARY, "b", &2u64);
        publisher.publish_ephemeral(TOPIC_SUMMARY, "c", &3u64);
        recorder.step();
        recorder.close();
        while let Ok(message) = client.try_recv() {
            seen.push(message.text().to_owned());
        }
        let log = RewindLog::open(dir.path()).unwrap();
        let recorded: Vec<String> = lines(&log, 1_000_000)
            .into_iter()
            .map(|line| line.split_once(' ').unwrap().1.to_owned())
            .collect();
        assert_eq!(recorded, seen);
    }

    #[test]
    fn test_a_new_segment_opens_after_the_span_with_its_own_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let (mut recorder, publisher, now) = recorder(dir.path(), settings());
        publisher.publish(TOPIC_SUMMARY, "cluster", &"testnet");
        recorder.step();
        let joined = publisher.joined();
        now.store(1_061_000, Ordering::Relaxed);
        publisher.publish(TOPIC_SUMMARY, "root_slot", &9u64);
        recorder.step();
        recorder.close();
        // The rotation counts as a join, so the collector sends a fresh slot overview.
        assert_eq!(publisher.joined(), joined.saturating_add(1));

        let log = RewindLog::open(dir.path()).unwrap();
        let starts: Vec<u64> = log.range().iter().map(|(start, _, _)| *start).collect();
        assert_eq!(starts, [1_000_000, 1_061_000]);
        let second = lines(&log, 1_061_000);
        assert!(
            second
                .iter()
                .any(|line| line.contains(r#""key":"cluster""#))
        );
        assert!(
            second
                .iter()
                .any(|line| line.contains(r#""key":"root_slot""#))
        );
        // The message that crossed the span went to the segment it arrived in.
        assert!(
            lines(&log, 1_000_000)
                .iter()
                .any(|line| line.contains("root_slot"))
        );
    }

    #[test]
    fn test_blocks_close_by_size_and_by_age() {
        let dir = tempfile::tempdir().unwrap();
        let (mut recorder, publisher, now) = recorder(dir.path(), settings());
        recorder.step();
        let long = "x".repeat(1500);
        for _ in 0..5 {
            publisher.publish_ephemeral(TOPIC_SUMMARY, "long", &long);
        }
        recorder.step();
        let held = recorder.log.range()[0].2;
        assert!(
            held >= 2,
            "five 1.5 KB lines fill a 4 KB block twice, {held}"
        );
        publisher.publish_ephemeral(TOPIC_SUMMARY, "short", &1u64);
        recorder.step();
        let before = recorder.log.range()[0].2;
        now.store(1_006_000, Ordering::Relaxed);
        recorder.step();
        assert_eq!(recorder.log.range()[0].2, before.saturating_add(1));
    }

    #[test]
    fn test_a_tail_cut_off_by_a_crash_is_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let (mut recorder, publisher, now) = recorder(dir.path(), settings());
        publisher.publish(TOPIC_SUMMARY, "cluster", &"testnet");
        recorder.step();
        now.store(1_006_000, Ordering::Relaxed);
        publisher.publish(TOPIC_SUMMARY, "root_slot", &7u64);
        recorder.step();
        now.store(1_012_000, Ordering::Relaxed);
        recorder.step();
        recorder.close();
        let path = dir.path().join(segment_name(1_000_000));
        let length = fs::metadata(&path).unwrap().len();
        let file = OpenOptions::new().write(true).open(&path).unwrap();
        file.set_len(length.saturating_sub(3)).unwrap();
        let log = RewindLog::open(dir.path()).unwrap();
        assert_eq!(log.range()[0].2, 1);
        assert!(log.read(1_000_000, 0).is_some());
        assert!(log.read(1_000_000, 1).is_none());
    }

    #[test]
    fn test_a_restart_leaves_two_segments_and_the_gap_between() {
        let dir = tempfile::tempdir().unwrap();
        let (mut first, publisher, _now) = recorder(dir.path(), settings());
        publisher.publish(TOPIC_SUMMARY, "cluster", &"testnet");
        first.step();
        first.close();
        drop(first);
        let (mut second, publisher, now) = recorder(dir.path(), settings());
        now.store(1_030_000, Ordering::Relaxed);
        publisher.publish(TOPIC_SUMMARY, "cluster", &"testnet");
        second.step();
        second.close();
        let starts: Vec<(u64, u64)> = RewindLog::open(dir.path())
            .unwrap()
            .range()
            .iter()
            .map(|(start, end, _)| (*start, *end))
            .collect();
        assert_eq!(starts, [(1_000_000, 1_000_000), (1_030_000, 1_030_000)]);
    }

    #[test]
    fn test_old_files_go_by_age_and_by_cap_and_foreign_files_stay() {
        let dir = tempfile::tempdir().unwrap();
        for start in [100_000u64, 900_000, 950_000] {
            fs::write(dir.path().join(segment_name(start)), vec![0u8; 1000]).unwrap();
        }
        fs::write(dir.path().join("notes.txt"), b"keep").unwrap();
        fs::write(dir.path().join("12.rewind.zst.bak"), b"keep").unwrap();
        fs::create_dir(dir.path().join("7.rewind.zst")).unwrap();
        let log = RewindLog::open(dir.path()).unwrap();
        let settings = Settings {
            cap_bytes: 1500,
            ..settings()
        };
        // 100 000 is past the retention; 900 000 goes for the cap; the open segment is spared.
        log.prune(1_000_000, &settings, Some(1_000_000));
        let mut left: Vec<String> = fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        left.sort();
        assert_eq!(
            left,
            [
                "12.rewind.zst.bak",
                "7.rewind.zst",
                "950000.rewind.zst",
                "notes.txt"
            ]
        );
    }

    #[test]
    fn test_unknown_segments_and_blocks_read_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let (mut recorder, _publisher, _now) = recorder(dir.path(), settings());
        recorder.step();
        recorder.close();
        let log = RewindLog::open(dir.path()).unwrap();
        assert!(log.read(1, 0).is_none());
        assert!(log.read(1_000_000, 99).is_none());
    }

    #[test]
    fn test_a_file_of_another_format_is_not_offered() {
        let dir = tempfile::tempdir().unwrap();
        let block = BlockIndex {
            offset: 0,
            compressed: 0,
            raw: 0,
            first: 5,
            last: 5,
            keyframe: true,
        };
        let mut header = encode_header(&block);
        header[8] = header[8].wrapping_add(1);
        fs::write(dir.path().join(segment_name(5)), header).unwrap();
        assert!(RewindLog::open(dir.path()).unwrap().range().is_empty());
    }

    #[test]
    fn test_a_directory_that_cannot_be_written_records_nothing_and_does_not_panic() {
        let dir = tempfile::tempdir().unwrap();
        let (mut recorder, publisher, _now) = recorder(dir.path(), settings());
        fs::remove_dir_all(dir.path()).unwrap();
        publisher.publish(TOPIC_SUMMARY, "cluster", &"testnet");
        recorder.step();
        recorder.close();
        assert!(recorder.log.range().is_empty());
    }

    #[test]
    fn test_a_write_that_fails_removes_the_empty_file_and_waits_before_trying_again() {
        let dir = tempfile::tempdir().unwrap();
        let (mut recorder, publisher, now) = recorder(dir.path(), settings());
        recorder.step();
        let path = dir.path().join(segment_name(1_000_000));
        // A handle that cannot write stands in for a full disk.
        recorder.open.as_mut().unwrap().file = File::open(&path).unwrap();
        publisher.publish(TOPIC_SUMMARY, "cluster", &"testnet");
        recorder.step();
        recorder.flush();
        assert!(recorder.open.is_none());
        assert!(!path.exists());
        assert!(recorder.log.range().is_empty());
        let joined = publisher.joined();
        for _ in 0..5 {
            recorder.step();
        }
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
        assert_eq!(
            publisher.joined(),
            joined,
            "no snapshot is taken while waiting"
        );
        now.store(1_001_000, Ordering::Relaxed);
        recorder.step();
        assert!(dir.path().join(segment_name(1_001_000)).exists());
    }

    #[test]
    fn test_falling_behind_starts_a_new_segment_on_a_fresh_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let (mut recorder, publisher, now) = recorder(dir.path(), settings());
        publisher.publish(TOPIC_SUMMARY, "cluster", &"testnet");
        recorder.step();
        for index in 0..9_000u64 {
            publisher.publish_ephemeral(TOPIC_SUMMARY, "flood", &index);
        }
        now.store(1_000_500, Ordering::Relaxed);
        recorder.step();
        recorder.close();
        let starts: Vec<u64> = recorder
            .log
            .range()
            .iter()
            .map(|(start, _, _)| *start)
            .collect();
        assert_eq!(starts, [1_000_000, 1_000_500]);
        assert!(
            lines(&recorder.log, 1_000_500)
                .iter()
                .any(|line| line.contains(r#""key":"cluster""#))
        );
    }

    #[test]
    fn test_segments_stay_in_order_when_the_clock_went_back_across_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let (mut first, publisher, now) = recorder(dir.path(), settings());
        now.store(2_000_000, Ordering::Relaxed);
        publisher.publish(TOPIC_SUMMARY, "cluster", &"testnet");
        first.step();
        first.close();
        let (mut second, publisher, _now) = recorder(dir.path(), settings());
        publisher.publish(TOPIC_SUMMARY, "cluster", &"testnet");
        second.step();
        second.close();
        let starts: Vec<u64> = second
            .log
            .range()
            .iter()
            .map(|(start, _, _)| *start)
            .collect();
        assert_eq!(starts, [1_000_000, 2_000_000]);
    }

    #[test]
    fn test_the_recorder_stops_on_exit() {
        let dir = tempfile::tempdir().unwrap();
        let (recorder, _publisher, _now) = recorder(dir.path(), settings());
        let exit = Arc::new(AtomicBool::new(false));
        let done = Arc::new(Mutex::new(false));
        let handle = {
            let exit = exit.clone();
            let done = done.clone();
            thread::spawn(move || {
                recorder.run(&exit);
                *done.lock().unwrap() = true;
            })
        };
        exit.store(true, Ordering::Relaxed);
        handle.join().unwrap();
        assert!(*done.lock().unwrap());
    }
}
