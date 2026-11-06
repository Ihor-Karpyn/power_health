-- Тестовий режим (/testStart, /testStop): запити телефона не застосовуються, а дублюються власнику
ALTER TABLE state ADD COLUMN test_since INTEGER;
ALTER TABLE state ADD COLUMN test_reminded_at INTEGER;
