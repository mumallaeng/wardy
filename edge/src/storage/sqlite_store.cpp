#include "storage/sqlite_store.hpp"

#include <sqlite3.h>

#include <filesystem>
#include <limits>
#include <stdexcept>
#include <string>
#include <utility>

namespace wardy::storage {
namespace {

class Statement {
 public:
  Statement(sqlite3* database, const char* sql) : database_(database) {
    if (sqlite3_prepare_v2(database_, sql, -1, &statement_, nullptr) != SQLITE_OK) {
      throw std::runtime_error(sqlite3_errmsg(database_));
    }
  }

  ~Statement() { sqlite3_finalize(statement_); }
  Statement(const Statement&) = delete;
  Statement& operator=(const Statement&) = delete;

  sqlite3_stmt* get() const noexcept { return statement_; }

 private:
  sqlite3* database_ = nullptr;
  sqlite3_stmt* statement_ = nullptr;
};

void execute(sqlite3* database, const char* sql) {
  char* error = nullptr;
  if (sqlite3_exec(database, sql, nullptr, nullptr, &error) != SQLITE_OK) {
    const std::string message = error ? error : sqlite3_errmsg(database);
    sqlite3_free(error);
    throw std::runtime_error(message);
  }
}

void bind_text(sqlite3_stmt* statement, int index, const std::string& value) {
  if (sqlite3_bind_text(statement, index, value.c_str(), -1, SQLITE_TRANSIENT) != SQLITE_OK) {
    throw std::runtime_error("failed to bind SQLite text value");
  }
}

void bind_optional_text(sqlite3_stmt* statement, int index,
                        const std::optional<std::string>& value) {
  if (value) {
    bind_text(statement, index, *value);
  } else if (sqlite3_bind_null(statement, index) != SQLITE_OK) {
    throw std::runtime_error("failed to bind SQLite null value");
  }
}

std::string column_text(sqlite3_stmt* statement, int index) {
  const auto* value = sqlite3_column_text(statement, index);
  return value ? reinterpret_cast<const char*>(value) : "";
}

std::optional<std::string> optional_column_text(sqlite3_stmt* statement, int index) {
  if (sqlite3_column_type(statement, index) == SQLITE_NULL) return std::nullopt;
  return column_text(statement, index);
}

void require_done(sqlite3* database, sqlite3_stmt* statement) {
  if (sqlite3_step(statement) != SQLITE_DONE) {
    throw std::runtime_error(sqlite3_errmsg(database));
  }
}

void validate_limit(std::size_t value, const char* name) {
  if (value > static_cast<std::size_t>(std::numeric_limits<int>::max())) {
    throw std::invalid_argument(std::string{name} + " is too large");
  }
}

}  // namespace

struct SqliteStore::Impl {
  explicit Impl(std::string database_path) : path(std::move(database_path)) {
    if (path.empty()) throw std::invalid_argument("database path must not be empty");
  }

  std::string path;
  sqlite3* database = nullptr;
};

SqliteStore::SqliteStore(std::string database_path)
    : impl_(std::make_unique<Impl>(std::move(database_path))) {}

SqliteStore::~SqliteStore() {
  if (impl_ && impl_->database) sqlite3_close(impl_->database);
}

SqliteStore::SqliteStore(SqliteStore&&) noexcept = default;
SqliteStore& SqliteStore::operator=(SqliteStore&&) noexcept = default;

void SqliteStore::initialize() {
  if (!impl_) throw std::logic_error("cannot initialize a moved-from SQLite store");
  if (impl_->database) return;

  if (impl_->path != ":memory:") {
    const std::filesystem::path path(impl_->path);
    if (path.has_parent_path()) std::filesystem::create_directories(path.parent_path());
  }

  if (sqlite3_open_v2(impl_->path.c_str(), &impl_->database,
                      SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX,
                      nullptr) != SQLITE_OK) {
    const std::string message = impl_->database ? sqlite3_errmsg(impl_->database)
                                                : "failed to open SQLite database";
    if (impl_->database) sqlite3_close(impl_->database);
    impl_->database = nullptr;
    throw std::runtime_error(message);
  }

  sqlite3_busy_timeout(impl_->database, 1000);
  execute(impl_->database, "PRAGMA foreign_keys = ON;");
  execute(impl_->database, "PRAGMA journal_mode = WAL;");
  execute(impl_->database, "PRAGMA synchronous = NORMAL;");
  execute(impl_->database, "PRAGMA cache_size = -2048;");
  execute(impl_->database, "PRAGMA wal_autocheckpoint = 200;");
  execute(impl_->database, R"SQL(
    CREATE TABLE IF NOT EXISTS schema_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT INTO schema_metadata(key, value) VALUES('schema_version', '2')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value;

    CREATE TABLE IF NOT EXISTS events (
      event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      subject_id TEXT,
      subject_name TEXT,
      subject_location TEXT NOT NULL,
      object_id TEXT,
      object_class TEXT,
      zone_id TEXT,
      care_status TEXT CHECK(care_status IN ('normal','caution','warning','emergency') OR care_status IS NULL),
      event_status TEXT NOT NULL CHECK(event_status IN ('new','confirmed','released','false_detection')),
      confirmed_at TEXT,
      released_at TEXT,
      false_detection_at TEXT,
      reason TEXT NOT NULL,
      source_results_json TEXT NOT NULL DEFAULT '[]',
      media_type TEXT NOT NULL CHECK(media_type IN ('none','image','video')),
      media_path TEXT,
      media_started_at TEXT,
      media_ended_at TEXT
    );
    CREATE INDEX IF NOT EXISTS events_occurred_at_idx ON events(occurred_at DESC);
    CREATE INDEX IF NOT EXISTS events_status_idx ON events(event_status, care_status, occurred_at DESC);

    CREATE TABLE IF NOT EXISTS system_state (
      singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
      care_state TEXT CHECK(care_state IN ('normal','caution','warning','emergency') OR care_state IS NULL),
      camera_state TEXT NOT NULL CHECK(camera_state IN ('idle','connecting','connected','fault')),
      detection_state TEXT NOT NULL CHECK(detection_state IN ('disconnected','ready','running','fault')),
      event_state TEXT NOT NULL CHECK(event_state IN ('ready','processing','fault')),
      reason TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS managed_items (
      item_id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      policy TEXT NOT NULL CHECK(policy IN ('included','excluded')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS training_samples (
      sample_id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL REFERENCES managed_items(item_id) ON DELETE CASCADE,
      image_path TEXT NOT NULL UNIQUE,
      captured_at TEXT NOT NULL,
      width INTEGER NOT NULL CHECK(width > 0),
      height INTEGER NOT NULL CHECK(height > 0),
      source TEXT NOT NULL DEFAULT 'jetson_camera',
      split TEXT NOT NULL DEFAULT 'unassigned'
    );
    CREATE INDEX IF NOT EXISTS training_samples_item_idx
      ON training_samples(item_id, captured_at DESC);
  )SQL");
}

void SqliteStore::upsert_event(const EventRecord& event) {
  if (!impl_ || !impl_->database) throw std::logic_error("SQLite store is not initialized");
  Statement statement(impl_->database, R"SQL(
    INSERT INTO events (
      event_id, event_type, occurred_at, first_seen_at, last_seen_at,
      subject_id, subject_name, subject_location, object_id, object_class, zone_id,
      care_status, event_status, confirmed_at, released_at, false_detection_at,
      reason, source_results_json, media_type, media_path, media_started_at, media_ended_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(event_id) DO UPDATE SET
      event_type=excluded.event_type, occurred_at=excluded.occurred_at,
      first_seen_at=excluded.first_seen_at, last_seen_at=excluded.last_seen_at,
      subject_id=excluded.subject_id, subject_name=excluded.subject_name,
      subject_location=excluded.subject_location, object_id=excluded.object_id,
      object_class=excluded.object_class, zone_id=excluded.zone_id,
      care_status=excluded.care_status, event_status=excluded.event_status,
      confirmed_at=excluded.confirmed_at, released_at=excluded.released_at,
      false_detection_at=excluded.false_detection_at, reason=excluded.reason,
      source_results_json=excluded.source_results_json, media_type=excluded.media_type,
      media_path=excluded.media_path, media_started_at=excluded.media_started_at,
      media_ended_at=excluded.media_ended_at;
  )SQL");

  int index = 1;
  bind_text(statement.get(), index++, event.event_id);
  bind_text(statement.get(), index++, event.event_type);
  bind_text(statement.get(), index++, event.occurred_at);
  bind_text(statement.get(), index++, event.first_seen_at);
  bind_text(statement.get(), index++, event.last_seen_at);
  bind_optional_text(statement.get(), index++, event.subject_id);
  bind_optional_text(statement.get(), index++, event.subject_name);
  bind_text(statement.get(), index++, event.subject_location);
  bind_optional_text(statement.get(), index++, event.object_id);
  bind_optional_text(statement.get(), index++, event.object_class);
  bind_optional_text(statement.get(), index++, event.zone_id);
  bind_optional_text(statement.get(), index++, event.care_status);
  bind_text(statement.get(), index++, event.event_status);
  bind_optional_text(statement.get(), index++, event.confirmed_at);
  bind_optional_text(statement.get(), index++, event.released_at);
  bind_optional_text(statement.get(), index++, event.false_detection_at);
  bind_text(statement.get(), index++, event.reason);
  bind_text(statement.get(), index++, event.source_results_json);
  bind_text(statement.get(), index++, event.media_type);
  bind_optional_text(statement.get(), index++, event.media_path);
  bind_optional_text(statement.get(), index++, event.media_started_at);
  bind_optional_text(statement.get(), index, event.media_ended_at);
  require_done(impl_->database, statement.get());
}

std::vector<EventRecord> SqliteStore::list_events(std::size_t limit,
                                                   std::size_t offset) const {
  if (!impl_ || !impl_->database) throw std::logic_error("SQLite store is not initialized");
  validate_limit(limit, "limit");
  validate_limit(offset, "offset");
  Statement statement(impl_->database, R"SQL(
    SELECT event_id, event_type, occurred_at, first_seen_at, last_seen_at,
      subject_id, subject_name, subject_location, object_id, object_class, zone_id,
      care_status, event_status, confirmed_at, released_at, false_detection_at,
      reason, source_results_json, media_type, media_path, media_started_at, media_ended_at
    FROM events ORDER BY occurred_at DESC LIMIT ? OFFSET ?;
  )SQL");
  sqlite3_bind_int(statement.get(), 1, static_cast<int>(limit));
  sqlite3_bind_int(statement.get(), 2, static_cast<int>(offset));

  std::vector<EventRecord> events;
  int result = SQLITE_ROW;
  while ((result = sqlite3_step(statement.get())) == SQLITE_ROW) {
    events.push_back({
        column_text(statement.get(), 0),  column_text(statement.get(), 1),
        column_text(statement.get(), 2),  column_text(statement.get(), 3),
        column_text(statement.get(), 4),  optional_column_text(statement.get(), 5),
        optional_column_text(statement.get(), 6), column_text(statement.get(), 7),
        optional_column_text(statement.get(), 8), optional_column_text(statement.get(), 9),
        optional_column_text(statement.get(), 10), optional_column_text(statement.get(), 11),
        column_text(statement.get(), 12), optional_column_text(statement.get(), 13),
        optional_column_text(statement.get(), 14), optional_column_text(statement.get(), 15),
        column_text(statement.get(), 16), column_text(statement.get(), 17),
        column_text(statement.get(), 18), optional_column_text(statement.get(), 19),
        optional_column_text(statement.get(), 20), optional_column_text(statement.get(), 21),
    });
  }
  if (result != SQLITE_DONE) throw std::runtime_error(sqlite3_errmsg(impl_->database));
  return events;
}

bool SqliteStore::update_event_status(const std::string& event_id,
                                      const std::string& event_status,
                                      const std::string& changed_at) {
  if (!impl_ || !impl_->database) throw std::logic_error("SQLite store is not initialized");
  Statement statement(impl_->database, R"SQL(
    UPDATE events SET
      event_status = ?,
      confirmed_at = CASE WHEN ? = 'confirmed' THEN ? ELSE confirmed_at END,
      released_at = CASE WHEN ? = 'released' THEN ? ELSE released_at END,
      false_detection_at = CASE WHEN ? = 'false_detection' THEN ? ELSE false_detection_at END
    WHERE event_id = ?;
  )SQL");
  bind_text(statement.get(), 1, event_status);
  bind_text(statement.get(), 2, event_status);
  bind_text(statement.get(), 3, changed_at);
  bind_text(statement.get(), 4, event_status);
  bind_text(statement.get(), 5, changed_at);
  bind_text(statement.get(), 6, event_status);
  bind_text(statement.get(), 7, changed_at);
  bind_text(statement.get(), 8, event_id);
  require_done(impl_->database, statement.get());
  return sqlite3_changes(impl_->database) > 0;
}

void SqliteStore::save_system_state(const SystemStateRecord& state) {
  if (!impl_ || !impl_->database) throw std::logic_error("SQLite store is not initialized");
  Statement statement(impl_->database, R"SQL(
    INSERT INTO system_state(singleton_id, care_state, camera_state, detection_state,
                             event_state, reason, updated_at)
    VALUES(1,?,?,?,?,?,?)
    ON CONFLICT(singleton_id) DO UPDATE SET
      care_state=excluded.care_state, camera_state=excluded.camera_state,
      detection_state=excluded.detection_state, event_state=excluded.event_state,
      reason=excluded.reason, updated_at=excluded.updated_at;
  )SQL");
  bind_optional_text(statement.get(), 1, state.care_state);
  bind_text(statement.get(), 2, state.camera_state);
  bind_text(statement.get(), 3, state.detection_state);
  bind_text(statement.get(), 4, state.event_state);
  bind_text(statement.get(), 5, state.reason);
  bind_text(statement.get(), 6, state.updated_at);
  require_done(impl_->database, statement.get());
}

std::optional<SystemStateRecord> SqliteStore::load_system_state() const {
  if (!impl_ || !impl_->database) throw std::logic_error("SQLite store is not initialized");
  Statement statement(impl_->database, R"SQL(
    SELECT care_state, camera_state, detection_state, event_state, reason, updated_at
    FROM system_state WHERE singleton_id = 1;
  )SQL");
  const int result = sqlite3_step(statement.get());
  if (result == SQLITE_DONE) return std::nullopt;
  if (result != SQLITE_ROW) throw std::runtime_error(sqlite3_errmsg(impl_->database));
  return SystemStateRecord{
      optional_column_text(statement.get(), 0), column_text(statement.get(), 1),
      column_text(statement.get(), 2), column_text(statement.get(), 3),
      column_text(statement.get(), 4), column_text(statement.get(), 5),
  };
}

void SqliteStore::upsert_managed_item(const ManagedItemRecord& item) {
  if (!impl_ || !impl_->database) throw std::logic_error("SQLite store is not initialized");
  Statement statement(impl_->database, R"SQL(
    INSERT INTO managed_items(item_id, label, policy, created_at, updated_at)
    VALUES(?,?,?,?,?)
    ON CONFLICT(item_id) DO UPDATE SET
      label=excluded.label, policy=excluded.policy, updated_at=excluded.updated_at;
  )SQL");
  bind_text(statement.get(), 1, item.item_id);
  bind_text(statement.get(), 2, item.label);
  bind_text(statement.get(), 3, item.policy);
  bind_text(statement.get(), 4, item.created_at);
  bind_text(statement.get(), 5, item.updated_at);
  require_done(impl_->database, statement.get());
}

void SqliteStore::add_training_sample(const TrainingSampleRecord& sample) {
  if (!impl_ || !impl_->database) throw std::logic_error("SQLite store is not initialized");
  Statement statement(impl_->database, R"SQL(
    INSERT INTO training_samples(sample_id, item_id, image_path, captured_at, width, height)
    VALUES(?,?,?,?,?,?);
  )SQL");
  bind_text(statement.get(), 1, sample.sample_id);
  bind_text(statement.get(), 2, sample.item_id);
  bind_text(statement.get(), 3, sample.image_path);
  bind_text(statement.get(), 4, sample.captured_at);
  sqlite3_bind_int(statement.get(), 5, sample.width);
  sqlite3_bind_int(statement.get(), 6, sample.height);
  require_done(impl_->database, statement.get());
}

std::size_t SqliteStore::count_training_samples(const std::string& item_id) const {
  if (!impl_ || !impl_->database) throw std::logic_error("SQLite store is not initialized");
  Statement statement(impl_->database,
                      "SELECT COUNT(*) FROM training_samples WHERE item_id = ?;");
  bind_text(statement.get(), 1, item_id);
  if (sqlite3_step(statement.get()) != SQLITE_ROW) {
    throw std::runtime_error(sqlite3_errmsg(impl_->database));
  }
  return static_cast<std::size_t>(sqlite3_column_int64(statement.get(), 0));
}

std::string SqliteStore::schema_version() const {
  if (!impl_ || !impl_->database) throw std::logic_error("SQLite store is not initialized");
  Statement statement(impl_->database,
                      "SELECT value FROM schema_metadata WHERE key = 'schema_version';");
  if (sqlite3_step(statement.get()) != SQLITE_ROW) {
    throw std::runtime_error(sqlite3_errmsg(impl_->database));
  }
  return column_text(statement.get(), 0);
}

std::string SqliteStore::journal_mode() const {
  if (!impl_ || !impl_->database) throw std::logic_error("SQLite store is not initialized");
  Statement statement(impl_->database, "PRAGMA journal_mode;");
  if (sqlite3_step(statement.get()) != SQLITE_ROW) {
    throw std::runtime_error(sqlite3_errmsg(impl_->database));
  }
  return column_text(statement.get(), 0);
}

const std::string& SqliteStore::path() const noexcept { return impl_->path; }

}  // namespace wardy::storage
