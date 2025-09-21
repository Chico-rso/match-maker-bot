import 'dotenv/config';
import express from 'express';
import { Telegraf, Markup } from 'telegraf';
import cron from 'node-cron';
import Database from 'better-sqlite3';

const app = express();

const TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 3000;

// ⚽ Конфигурация форматов
const FORMATS = {
    '6x6': 12,
    '7x7': 14,
    '8x8': 16,
    '9x9': 18,
};

// 📝 Функция для создания кликабельного упоминания пользователя
function formatPlayerMention(member) {
    const fullName = `${ member.first_name }${ member.last_name ? ` ${ member.last_name }` : '' }`;

    if (member.username) {
        return `[@${ member.username }](tg://user?id=${ member.id })`;
    } else {
        return `[${ fullName }](tg://user?id=${ member.id })`;
    }
}

// 📝 Функция для красивого форматирования списка игроков
function formatPlayersList(players, maxDisplay = 8) {
    if (!players || players.length === 0) {
        return 'нет';
    }

    const displayPlayers = players.slice(0, maxDisplay);
    const remaining = players.length - maxDisplay;

    let result = '';

    // Если игроков не больше 3, показываем в одну строку
    if (displayPlayers.length <= 3) {
        result = displayPlayers.map(formatPlayerMention).join(', ');
    } else {
        // Иначе показываем с нумерацией, по 2-3 в строке
        const lines = [];
        for (let i = 0; i < displayPlayers.length; i += 3) {
            const line = displayPlayers.slice(i, i + 3)
                .map((player, idx) => `${i + idx + 1}. ${formatPlayerMention(player)}`)
                .join('  ');
            lines.push(line);
        }
        result = lines.join('\n');
    }

    if (remaining > 0) {
        result += `\n...и ещё ${remaining} ${getPlayerWord(remaining)}`;
    }

    return result;
}

// 📝 Вспомогательная функция для правильного склонения слова "игрок"
function getPlayerWord(count) {
    if (count % 10 === 1 && count % 100 !== 11) {
        return 'игрок';
    }
    if (count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 10 || count % 100 >= 20)) {
        return 'игрока';
    }
    return 'игроков';
}

// 📝 Функция для валидации даты в формате YYYY-MM-DD
function validateDate(dateStr) {
    if (!dateStr) return null;
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(dateStr)) return null;

    const date = new Date(dateStr + 'T00:00:00');
    if (isNaN(date.getTime())) return null;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (date < today) return null; // Дата не может быть в прошлом

    return dateStr;
}

// 📝 Функция для валидации времени в формате HH:MM
function validateTime(timeStr) {
    if (!timeStr) return null;
    const timeRegex = /^\d{2}:\d{2}$/;
    if (!timeRegex.test(timeStr)) return null;

    const [hours, minutes] = timeStr.split(':').map(Number);
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;

    return timeStr;
}

// 📝 Функция для форматирования даты и времени
function formatDateTime(date, time) {
    if (!date && !time) return '';

    let result = '';
    if (date) {
        const dateObj = new Date(date);
        const options = { weekday: 'short', month: 'short', day: 'numeric' };
        result += dateObj.toLocaleDateString('ru-RU', options);
    }
    if (time) {
        if (result) result += ' в ';
        result += time;
    }
    return result;
}

// 📊 Подключение SQLite
const db = new Database('bot.db');

// Создаём таблицы (если их нет)
db.prepare(
    `CREATE TABLE IF NOT EXISTS members
        (
            id
            TEXT
            PRIMARY
            KEY,
            username
            TEXT,
            first_name
            TEXT,
            last_name
            TEXT
        )`,
).run();

db.prepare(
    `CREATE TABLE IF NOT EXISTS sessions
     (
         id
         INTEGER
         PRIMARY
         KEY
         AUTOINCREMENT,
         chat_id
         INTEGER,
         format
         TEXT,
         needed_players
         INTEGER,
         is_active
         INTEGER,
         date
         TEXT,
         time
         TEXT
     )`,
).run();

// Миграция: добавляем автора голосования, если столбца нет
try {
    db.prepare(`ALTER TABLE sessions
        ADD COLUMN author_id TEXT`).run();
} catch (e) {
    // столбец уже существует — игнорируем
}

// Миграция: добавляем username, first_name и last_name в members, если столбцов нет
try {
    db.prepare(`ALTER TABLE members
        ADD COLUMN username TEXT`).run();
    db.prepare(`ALTER TABLE members
        ADD COLUMN first_name TEXT`).run();
    db.prepare(`ALTER TABLE members
        ADD COLUMN last_name TEXT`).run();
} catch (e) {
    // столбцы уже существуют — игнорируем
}

// Миграция: добавляем date и time в sessions, если столбцов нет
try {
    db.prepare(`ALTER TABLE sessions
        ADD COLUMN date TEXT`).run();
    db.prepare(`ALTER TABLE sessions
        ADD COLUMN time TEXT`).run();
} catch (e) {
    // столбцы уже существуют — игнорируем
}

db.prepare(
    `CREATE TABLE IF NOT EXISTS votes
    (
        user_id
        TEXT,
        vote
        TEXT,
        session_id
        INTEGER,
        PRIMARY
        KEY
     (
        user_id,
        session_id
     )
        )`,
).run();

const bot = new Telegraf(TOKEN);

// Регистрируем меню команд с готовыми опциями
bot.telegram.setMyCommands([
    {command: 'start_vote', description: 'Запустить голосование: /start_vote 6x6|7x7|8x8|9x9 [дата YYYY-MM-DD] [время HH:MM]'},
    {command: 'start_6x6', description: 'Запустить голосование 6x6 [дата] [время]'},
    {command: 'start_7x7', description: 'Запустить голосование 7x7 [дата] [время]'},
    {command: 'start_8x8', description: 'Запустить голосование 8x8 [дата] [время]'},
    {command: 'start_9x9', description: 'Запустить голосование 9x9 [дата] [время]'},
    {command: 'set_datetime', description: 'Изменить дату/время: /set_datetime YYYY-MM-DD HH:MM'},
    {command: 'end_vote', description: 'Завершить текущее голосование'},
]);

// Хелпер старта голосования c проверками
async function startVoteWithFormat(ctx, fmt, date = null, time = null) {
    if (!fmt || !FORMATS[fmt]) {
        return ctx.reply('⚠️ Укажи формат: /start_vote 6x6 | 7x7 | 8x8 | 9x9 [дата YYYY-MM-DD] [время HH:MM]');
    }

    // Валидация даты и времени
    const validDate = validateDate(date);
    const validTime = validateTime(time);

    if (date && !validDate) {
        return ctx.reply('⚠️ Неверный формат даты. Используй YYYY-MM-DD (например: 2025-09-22)');
    }
    if (time && !validTime) {
        return ctx.reply('⚠️ Неверный формат времени. Используй HH:MM (например: 19:00)');
    }

    try {
        const member = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id);
        const isAdmin = member.status === 'administrator' || member.status === 'creator';
        if (!isAdmin) {
            return ctx.reply('🚫 Запускать голосование могут только администраторы.');
        }
    } catch (err) {
        return ctx.reply('🚫 Не удалось проверить права. Попробуйте позже.');
    }
    const existingActive = db
    .prepare(`SELECT id, format, needed_players, date, time
              FROM sessions
              WHERE chat_id = ?
                AND is_active = 1`)
    .get(ctx.chat.id);
    if (existingActive) {
        const dateTimeInfo = formatDateTime(existingActive.date, existingActive.time);
        const dateTimeText = dateTimeInfo ? `\n🗓️ ${dateTimeInfo}` : '';
        return ctx.reply(
            `⚠️ В этом чате уже запущено голосование (формат: ${ existingActive.format }).${dateTimeText}\n` +
            `Чтобы начать новое, завершите текущее командой /end_vote.`,
        );
    }
    const info = db
    .prepare(
        `INSERT INTO sessions (chat_id, format, needed_players, is_active, author_id, date, time)
         VALUES (?, ?, ?, 1, ?, ?, ?)`,
    )
    .run(ctx.chat.id, fmt, FORMATS[fmt], ctx.from.id.toString(), validDate, validTime);
    const sessionId = info.lastInsertRowid;

    const dateTimeInfo = formatDateTime(validDate, validTime);
    const dateTimeText = dateTimeInfo ? `\n🗓️ ${dateTimeInfo}` : '';

    return ctx.reply(
        `⚽ Голосование началось!\nФормат: ${ fmt } (нужно ${ FORMATS[fmt] } игроков)${dateTimeText}\n\nКто играет?`,
        Markup.inlineKeyboard([
            [Markup.button.callback('✅ Играю', `vote:yes:${ sessionId }`)],
            [Markup.button.callback('❌ Не играю', `vote:no:${ sessionId }`)],
            [Markup.button.callback('🤔 Не знаю', `vote:maybe:${ sessionId }`)],
        ]),
    );
}

// 📌 Добавляем новых участников в БД
bot.on('new_chat_members', (ctx) => {
    ctx.message.new_chat_members.forEach((member) => {
        const id = member.id.toString();
        const username = member.username;
        const firstName = member.first_name || 'Пользователь';
        const lastName = member.last_name || '';
        db.prepare(
            `INSERT
            OR REPLACE INTO members (id, username, first_name, last_name) VALUES (?, ?, ?, ?)`,
        ).run(id, username, firstName, lastName);
    });
});

// 📌 Удаляем тех, кто вышел
bot.on('left_chat_member', (ctx) => {
    const member = ctx.message.left_chat_member;
    db.prepare(`DELETE
                FROM members
                WHERE id = ?`).run(member.id.toString());
});

// 🏁 Команда старта голосования
bot.command('start_vote', async (ctx) => {
    const args = ctx.message.text.split(' ');
    const fmt = args[1];
    const date = args[2];
    const time = args[3];
    await startVoteWithFormat(ctx, fmt, date, time);
});

// Алиасы для быстрого старта через слэш
bot.command('start_6x6', async (ctx) => {
    const args = ctx.message.text.split(' ');
    const date = args[1];
    const time = args[2];
    await startVoteWithFormat(ctx, '6x6', date, time);
});
bot.command('start_7x7', async (ctx) => {
    const args = ctx.message.text.split(' ');
    const date = args[1];
    const time = args[2];
    await startVoteWithFormat(ctx, '7x7', date, time);
});
bot.command('start_8x8', async (ctx) => {
    const args = ctx.message.text.split(' ');
    const date = args[1];
    const time = args[2];
    await startVoteWithFormat(ctx, '8x8', date, time);
});
bot.command('start_9x9', async (ctx) => {
    const args = ctx.message.text.split(' ');
    const date = args[1];
    const time = args[2];
    await startVoteWithFormat(ctx, '9x9', date, time);
});

// 🎛 Обработка кнопок голосования
bot.on('callback_query', async (ctx) => {
    const [action, vote, sessionId] = ctx.callbackQuery.data.split(':');
    
    if (action !== 'vote') return;
    
    const activeSession = db
    .prepare(`SELECT *, date, time
              FROM sessions
              WHERE id = ?
                AND is_active = 1`)
    .get(sessionId);

    if (!activeSession) {
        return ctx.answerCbQuery('⚠️ Голосование не активно');
    }
    
    const userId = ctx.from.id.toString();
    const username = ctx.from.username;
    const firstName = ctx.from.first_name || 'Пользователь';
    const lastName = ctx.from.last_name || '';

    // Проверяем, не совпадает ли голос с предыдущим
    const existing = db
    .prepare(`SELECT vote
              FROM votes
              WHERE user_id = ?
                AND session_id = ?`)
    .get(userId, sessionId);

    if (existing && existing.vote === vote) {
        await ctx.answerCbQuery('Без изменений: ваш голос уже учтён.');
        return;
    }

    db.prepare(
        `INSERT
        OR REPLACE INTO members (id, username, first_name, last_name) VALUES (?, ?, ?, ?)`,
    ).run(userId, username, firstName, lastName);
    
    db.prepare(
        `INSERT
        OR REPLACE INTO votes (user_id, vote, session_id) VALUES (?, ?, ?)`,
    ).run(userId, vote, sessionId);
    
    // Считаем голоса
    const votes = db
    .prepare(`SELECT vote, COUNT(*) as count
              FROM votes
              WHERE session_id = ?
              GROUP BY vote`)
    .all(sessionId);
    
    const yes = db
    .prepare(`SELECT m.id, m.username, m.first_name, m.last_name
              FROM votes v
                        JOIN members m ON v.user_id = m.id
              WHERE v.vote = 'yes'
                AND v.session_id = ?`)
    .all(sessionId);

    const no = db
    .prepare(`SELECT m.id, m.username, m.first_name, m.last_name
              FROM votes v
                        JOIN members m ON v.user_id = m.id
              WHERE v.vote = 'no'
                AND v.session_id = ?`)
    .all(sessionId);

    const maybe = db
    .prepare(`SELECT m.id, m.username, m.first_name, m.last_name
              FROM votes v
                        JOIN members m ON v.user_id = m.id
              WHERE v.vote = 'maybe'
                AND v.session_id = ?`)
    .all(sessionId);
    
    const totalYes = yes.length;
    
    const dateTimeInfo = formatDateTime(activeSession.date, activeSession.time);
    const dateTimeText = dateTimeInfo ? `\n🗓️ ${dateTimeInfo}` : '';

    try {
        await ctx.editMessageText(
            `⚽ Формат: ${ activeSession.format }${dateTimeText}\n` +
            `✅ Играют: ${ formatPlayersList(yes) }\n` +
            `❌ Не играют: ${ formatPlayersList(no) }\n` +
            `🤔 Думают: ${ formatPlayersList(maybe) }\n\n` +
            `Игроков нужно: ${ activeSession.needed_players }, уже есть: ${ totalYes }`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('✅ Играю', `vote:yes:${ sessionId }`)],
                    [Markup.button.callback('❌ Не знаю', `vote:maybe:${ sessionId }`)],
                    [Markup.button.callback('❌ Не играю', `vote:no:${ sessionId }`)],
                ])
            }
        );
    } catch (err) {
        const desc = err?.response?.description || err?.description || err?.message || '';
        if (!desc.includes('message is not modified')) {
            console.error('editMessageText failed:', err);
        }
    }
    
    if (totalYes >= activeSession.needed_players) {
        db.prepare(`UPDATE sessions
                    SET is_active = 0
                    WHERE id = ?`).run(sessionId);
        await ctx.reply(
            `🎉 Набралось ${ activeSession.needed_players } игроков! Матч состоится! Сбор закрыт ✅`,
        );
    }
    
    await ctx.answerCbQuery('Голос учтен!');
});

// 🛑 Завершить текущее голосование
bot.command('end_vote', async (ctx) => {
    const active = db
    .prepare(`SELECT id, author_id
              FROM sessions
              WHERE chat_id = ?
                AND is_active = 1`)
    .get(ctx.chat.id);
    
    if (!active) {
        return ctx.reply('ℹ️ Активного голосования нет. Запустить: /start_vote 6x6 | 7x7 | 8x8 | 9x9');
    }
    
    let isAdmin = false;
    try {
        const member = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id);
        isAdmin = member.status === 'administrator' || member.status === 'creator';
    } catch (err) {
        // если не смогли проверить — считаем, что не админ
        isAdmin = false;
    }
    
    const isAuthor = active.author_id && active.author_id === ctx.from.id.toString();
    if (!isAdmin && !isAuthor) {
        return ctx.reply('🚫 Завершать голосование могут только администраторы или автор голосования.');
    }
    
    db.prepare(`UPDATE sessions
                SET is_active = 0
                WHERE id = ?`).run(active.id);
    
    await ctx.reply('✅ Голосование завершено. Можно запустить новое: /start_vote 6x6 | 7x7 | 8x8 | 9x9');
});

// 🕐 Изменить дату и время голосования
bot.command('set_datetime', async (ctx) => {
    const args = ctx.message.text.split(' ');
    const date = args[1];
    const time = args[2];

    if (!date && !time) {
        return ctx.reply('⚠️ Укажи дату и/или время: /set_datetime YYYY-MM-DD HH:MM\nПример: /set_datetime 2025-09-22 19:00');
    }

    const validDate = validateDate(date);
    const validTime = validateTime(time);

    if (date && !validDate) {
        return ctx.reply('⚠️ Неверный формат даты. Используй YYYY-MM-DD (например: 2025-09-22)');
    }
    if (time && !validTime) {
        return ctx.reply('⚠️ Неверный формат времени. Используй HH:MM (например: 19:00)');
    }

    try {
        const member = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id);
        const isAdmin = member.status === 'administrator' || member.status === 'creator';
        if (!isAdmin) {
            return ctx.reply('🚫 Изменять дату/время могут только администраторы.');
        }
    } catch (err) {
        return ctx.reply('🚫 Не удалось проверить права. Попробуйте позже.');
    }

    const activeSession = db
    .prepare(`SELECT id, format, date, time
              FROM sessions
              WHERE chat_id = ?
                AND is_active = 1`)
    .get(ctx.chat.id);

    if (!activeSession) {
        return ctx.reply('ℹ️ Активного голосования нет. Сначала запусти голосование командой /start_vote');
    }

    // Обновляем дату и время
    db.prepare(`UPDATE sessions SET date = ?, time = ? WHERE id = ?`)
    .run(validDate || activeSession.date, validTime || activeSession.time, activeSession.id);

    const newDateTimeInfo = formatDateTime(validDate || activeSession.date, validTime || activeSession.time);
    const dateTimeText = newDateTimeInfo ? `\n🗓️ ${newDateTimeInfo}` : '';

    await ctx.reply(`✅ Дата и время обновлены!${dateTimeText}`);
});

// 🔔 Напоминания каждые 2 часа
cron.schedule('0 */2 * * *', async () => {
    const activeSessions = db
    .prepare(`SELECT id, chat_id
              FROM sessions
              WHERE is_active = 1`)
    .all();
    
    if (!activeSessions || activeSessions.length === 0) {
        return;
    }
    
    for (const session of activeSessions) {
        const votedUserIds = db
        .prepare(`SELECT user_id
                  FROM votes
                  WHERE session_id = ?`)
        .all(session.id)
        .map((r) => r.user_id);
        
        const members = db.prepare(`SELECT id, username, first_name, last_name
                                    FROM members`).all();

        const notVotedMembers = members.filter((m) => !votedUserIds.includes(m.id));
        const mentions = notVotedMembers
        .map(formatPlayerMention)
        .filter((s) => s.length > 0)
        .join(', ');

        if (mentions.length > 0) {
            await bot.telegram.sendMessage(
                session.chat_id,
                `⏰ Напоминание! Проголосуйте, если ещё не отметились.\n` +
                mentions,
                { parse_mode: 'Markdown' }
            );
        }
    }
});

// 🚀 Express healthcheck
app.get('/', (req, res) => {
    res.send('Telegram bot with SQLite is running...');
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${ PORT }`);
});

// ▶️ Запуск
bot.launch();
