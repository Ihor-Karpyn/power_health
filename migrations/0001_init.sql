-- Поточний стан (завжди один рядок з id = 1)
CREATE TABLE state (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  -- 'on' | 'off' | 'paused' | NULL (ще невідомо)
  mode               TEXT CHECK (mode IN ('on', 'off', 'paused')),
  mode_since         INTEGER,                    -- ms, початок поточного періоду
  mode_since_approx  INTEGER NOT NULL DEFAULT 0, -- 1 = час відновлено з heartbeat, приблизний
  paused_by          TEXT,
  pause_reminded_at  INTEGER,
  -- Останнє, що повідомив телефон
  phone_charging     INTEGER,
  phone_ts           INTEGER,                    -- ms, час на телефоні в останньому звіті
  battery            INTEGER,
  last_seen          INTEGER,                    -- ms, коли сервер востаннє отримав запит від телефона
  detector_offline   INTEGER NOT NULL DEFAULT 0, -- 1 = вже надіслали «детектор не на зв'язку»
  -- Канал для сповіщень (вмикається командою /activate)
  channel_id             INTEGER,
  channel_title          TEXT
);
INSERT INTO state (id) VALUES (1);

-- Історія: світло є / світла нема / пауза. Поточний період має end_ts = NULL.
CREATE TABLE periods (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL CHECK (kind IN ('on', 'off', 'paused')),
  start_ts      INTEGER NOT NULL,
  end_ts        INTEGER,
  start_approx  INTEGER NOT NULL DEFAULT 0,
  end_approx    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX periods_start ON periods (start_ts);
CREATE INDEX periods_open ON periods (end_ts) WHERE end_ts IS NULL;

