-- Попередження перед відключенням: щоб відредагувати його, коли з'явиться графік на завтра
ALTER TABLE state ADD COLUMN warn_message_chat_id INTEGER;
ALTER TABLE state ADD COLUMN warn_message_id INTEGER;
ALTER TABLE state ADD COLUMN warn_sent_at INTEGER;
ALTER TABLE state ADD COLUMN warn_text TEXT;
