-- Повідомлення «світло з'явилось»: щоб видалити його, якщо світло знову зникне менш ніж за 5 хв
ALTER TABLE state ADD COLUMN on_message_chat_id INTEGER;
ALTER TABLE state ADD COLUMN on_message_id INTEGER;
