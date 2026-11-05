-- Попередження перед відключенням: початок інтервалу, про який уже попередили (ms)
ALTER TABLE state ADD COLUMN warned_outage_start INTEGER;
-- Графік на завтра: місцева дата (YYYY-MM-DD), коли його вже надіслали
ALTER TABLE state ADD COLUMN tomorrow_sent_date TEXT;
-- Закріплене повідомлення зі станом у каналі
ALTER TABLE state ADD COLUMN status_message_chat_id INTEGER;
ALTER TABLE state ADD COLUMN status_message_id INTEGER;
ALTER TABLE state ADD COLUMN status_text TEXT;
-- 1 = уже попередили власника, що боту бракує права закріплювати
ALTER TABLE state ADD COLUMN status_pin_warned INTEGER NOT NULL DEFAULT 0;
