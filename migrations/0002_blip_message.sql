-- Повідомлення «світло зникло» в каналі: щоб видалити його, якщо відключення виявиться коротким
ALTER TABLE state ADD COLUMN off_message_chat_id INTEGER;
ALTER TABLE state ADD COLUMN off_message_id INTEGER;
