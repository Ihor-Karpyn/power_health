-- Адреса на сайті ДТЕК (задається командою /address)
ALTER TABLE state ADD COLUMN dtek_street TEXT;
ALTER TABLE state ADD COLUMN dtek_house TEXT;
-- Частини повідомлення «світло зникло», щоб перемальовувати його, коли ДТЕК оновить дані (JSON)
ALTER TABLE state ADD COLUMN off_parts TEXT;
-- Останнє, що ДТЕК повідомив про поточне відключення (JSON)
ALTER TABLE state ADD COLUMN off_dtek TEXT;
