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
    // Если есть first_name (новый формат), используем его
    if (member.first_name) {
        const fullName = `${ member.first_name }${ member.last_name ? ` ${ member.last_name }` : '' }`;

        if (member.username) {
            return `[@${ member.username }](tg://user?id=${ member.id })`;
        } else {
            return `[${ fullName }](tg://user?id=${ member.id })`;
        }
    } else {
        // Старый формат - только username
        return member.username ? `@${ member.username }` : `Пользователь ${ member.id }`;
    }
}

// 📝 Функция для красивого форматирования списка игроков
function formatPlayersList(players, maxDisplay = 100) {
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

function toISODate(dateObj) {
    const year = dateObj.getFullYear();
    const month = String(dateObj.getMonth() + 1).padStart(2, '0');
    const day = String(dateObj.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// 📝 Гибкий парсер даты: YYYY-MM-DD, DD.MM, DD.MM.YYYY, сегодня/завтра/послезавтра
function parseDateInput(dateInput) {
    if (!dateInput) return null;

    const raw = dateInput.trim().toLowerCase();
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (raw === 'today' || raw === 'сегодня') {
        return toISODate(today);
    }
    if (raw === 'tomorrow' || raw === 'завтра') {
        const d = new Date(today);
        d.setDate(d.getDate() + 1);
        return toISODate(d);
    }
    if (raw === 'послезавтра') {
        const d = new Date(today);
        d.setDate(d.getDate() + 2);
        return toISODate(d);
    }

    const dotted = raw.match(/^(\d{2})\.(\d{2})(?:\.(\d{4}))?$/);
    if (dotted) {
        const day = Number(dotted[1]);
        const month = Number(dotted[2]);
        let year = dotted[3] ? Number(dotted[3]) : today.getFullYear();

        if (month < 1 || month > 12 || day < 1 || day > 31) return null;

        let normalized = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        if (!validateDate(normalized) && !dotted[3]) {
            year += 1;
            normalized = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        }
        return validateDate(normalized);
    }

    return validateDate(raw);
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

function resolveDateTimeStatus(status, date, time) {
    if (status === 'tentative' || status === 'confirmed') {
        return status;
    }
    return (date && time) ? 'confirmed' : 'tentative';
}

function formatScheduleLine(date, time, status) {
    const resolvedStatus = resolveDateTimeStatus(status, date, time);
    const dateTimeInfo = formatDateTime(date, time);

    if (resolvedStatus === 'tentative') {
        if (dateTimeInfo) {
            return `⏳ Предварительно: ${dateTimeInfo}`;
        }
        return '⏳ Предварительно: время уточняется';
    }

    if (dateTimeInfo) {
        return `✅ Подтверждено: ${dateTimeInfo}`;
    }
    return '✅ Подтверждено: время будет объявлено';
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

// Миграция: добавляем недостающие столбцы
const migrateTable = (tableName, columnName, columnType) => {
    try {
        const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
        const columnExists = columns.some(col => col.name === columnName);

        if (!columnExists) {
            db.prepare(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`).run();
            console.log(`✅ Добавлен столбец ${columnName} в таблицу ${tableName}`);
        }
    } catch (e) {
        console.error(`❌ Ошибка миграции столбца ${columnName}:`, e.message);
    }
};

// Выполняем миграции
migrateTable('sessions', 'author_id', 'TEXT');
migrateTable('members', 'username', 'TEXT');
migrateTable('members', 'first_name', 'TEXT');
migrateTable('members', 'last_name', 'TEXT');
migrateTable('sessions', 'date', 'TEXT');
migrateTable('sessions', 'time', 'TEXT');
migrateTable('sessions', 'message_id', 'INTEGER');
migrateTable('sessions', 'datetime_status', 'TEXT');

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

db.prepare(
    `CREATE TABLE IF NOT EXISTS draft_sessions
    (
        chat_id
        INTEGER
        PRIMARY
        KEY,
        format
        TEXT,
        date
        TEXT,
        time
        TEXT,
        created_at
        DATETIME
        DEFAULT
        CURRENT_TIMESTAMP
    )`,
).run();

migrateTable('draft_sessions', 'datetime_status', 'TEXT');

const bot = new Telegraf(TOKEN);

// Регистрируем меню команд с готовыми опциями
bot.telegram.setMyCommands([
    {command: 'start', description: 'Показать быстрый гид по боту'},
    {command: 'start_vote', description: 'Выбрать формат игры: /start_vote 6x6|7x7|8x8|9x9'},
    {command: 'set_time', description: 'Предв. время: /set_time сегодня 19:00'},
    {command: 'set_tentative', description: 'Сделать время предварительным'},
    {command: 'confirm_datetime', description: 'Подтвердить точные дату/время'},
    {command: 'confirm_vote', description: 'Запустить голосование'},
    {command: 'cancel_setup', description: 'Отменить настройку голосования'},
    {command: 'set_datetime', description: 'Изменить дату/время: /set_datetime YYYY-MM-DD HH:MM'},
    {command: 'end_vote', description: 'Завершить текущее голосование'},
]);

const HELP_TEXT =
    `🤖 Это бот для набора игроков на матч.\n\n` +
    `Быстрый сценарий:\n` +
    `1) /start_vote 6x6|7x7|8x8|9x9\n` +
    `2) /set_time сегодня 19:00 (можно: завтра, 22.09, 2026-02-21)\n` +
    `3) /confirm_vote\n\n` +
    `Если время пока не точное:\n` +
    `• /set_tentative [дата] [время]\n` +
    `Когда время стало точным:\n` +
    `• /confirm_datetime YYYY-MM-DD HH:MM\n\n` +
    `Во время активного сбора:\n` +
    `• /set_datetime YYYY-MM-DD HH:MM — поменять дату/время\n` +
    `• /end_vote — завершить голосование`;

bot.start((ctx) => ctx.reply(HELP_TEXT));
bot.command('help', (ctx) => ctx.reply(HELP_TEXT));

// Хелпер старта голосования c проверками
async function startVoteWithFormat(ctx, fmt, date = null, time = null) {
    if (!fmt || !FORMATS[fmt]) {
        return ctx.reply('⚠️ Укажи формат: /start_vote 6x6 | 7x7 | 8x8 | 9x9 [дата] [время HH:MM]');
    }

    // Валидация даты и времени
    const validDate = parseDateInput(date);
    const validTime = validateTime(time);
    const datetimeStatus = (validDate && validTime) ? 'confirmed' : 'tentative';

    if (date && !validDate) {
        return ctx.reply('⚠️ Неверный формат даты. Примеры: 2026-02-21, 21.02, сегодня, завтра');
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
    .prepare(`SELECT id, format, needed_players, date, time, datetime_status
              FROM sessions
              WHERE chat_id = ?
                AND is_active = 1`)
    .get(ctx.chat.id);
    if (existingActive) {
        const scheduleLine = formatScheduleLine(existingActive.date, existingActive.time, existingActive.datetime_status);
        return ctx.reply(
            `⚠️ В этом чате уже запущено голосование (формат: ${ existingActive.format }).\n${scheduleLine}\n` +
            `Чтобы начать новое, завершите текущее командой /end_vote.`,
        );
    }
    const info = db
    .prepare(
        `INSERT INTO sessions (chat_id, format, needed_players, is_active, author_id, date, time, datetime_status)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
    )
    .run(ctx.chat.id, fmt, FORMATS[fmt], ctx.from.id.toString(), validDate, validTime, datetimeStatus);
    const sessionId = info.lastInsertRowid;

    const scheduleLine = formatScheduleLine(validDate, validTime, datetimeStatus);

    const message = await ctx.reply(
        `⚽ Голосование началось!\nФормат: ${ fmt } (нужно ${ FORMATS[fmt] } игроков)\n${scheduleLine}\n\nКто играет?`,
        Markup.inlineKeyboard([
            [Markup.button.callback('✅ Играю', `vote:yes:${ sessionId }`)],
            [Markup.button.callback('❌ Не играю', `vote:no:${ sessionId }`)],
            [Markup.button.callback('🤔 Не знаю', `vote:maybe:${ sessionId }`)],
        ]),
    );

    // Сохраняем ID сообщения голосования
    db.prepare(`UPDATE sessions SET message_id = ? WHERE id = ?`).run(message.message_id, sessionId);

    await sendVoteStartNotification(ctx.chat.id, sessionId, message.message_id);
}

// 📣 Мгновенное уведомление всем, кто ещё не проголосовал, при старте голосования
async function sendVoteStartNotification(chatId, sessionId, messageId) {
    const votedUserIds = db
    .prepare(`SELECT user_id
              FROM votes
              WHERE session_id = ?`)
    .all(sessionId)
    .map((r) => r.user_id);

    // Поддержка старой и новой схемы members
    let membersQuery = `SELECT id`;
    try {
        db.prepare(`SELECT first_name FROM members LIMIT 1`).get();
        membersQuery += `, username, first_name, last_name`;
    } catch (e) {
        membersQuery += `, username`;
    }
    membersQuery += ` FROM members`;

    const members = db.prepare(membersQuery).all();
    const notVotedMembers = members.filter((m) => !votedUserIds.includes(m.id));
    const mentions = notVotedMembers
    .map(formatPlayerMention)
    .filter((s) => s.length > 0)
    .join(', ');

    if (!mentions) {
        return;
    }

    let voteLink = '';
    if (messageId) {
        const normalizedChatId = chatId.toString().replace('-', '');
        voteLink = ` [Открыть голосование](https://t.me/c/${normalizedChatId}/${messageId})`;
    }

    try {
        await bot.telegram.sendMessage(
            chatId,
            `📢 Голосование запущено! Пожалуйста, отметьтесь.${voteLink}\n${mentions}`,
            { parse_mode: 'Markdown' },
        );
    } catch (err) {
        console.error('sendVoteStartNotification failed:', err?.message || err);
    }
}

function getSessionVoteLists(sessionId) {
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

    return { yes, no, maybe };
}

async function refreshVoteMessage(sessionId) {
    const session = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(sessionId);
    if (!session) {
        return { totalYes: 0 };
    }

    const { yes, no, maybe } = getSessionVoteLists(sessionId);
    const totalYes = yes.length;
    const scheduleLine = formatScheduleLine(session.date, session.time, session.datetime_status);

    if (session.message_id) {
        try {
            await bot.telegram.editMessageText(
                session.chat_id,
                session.message_id,
                undefined,
                `⚽ Формат: ${ session.format }\n` +
                `${scheduleLine}\n` +
                `✅ Играют: ${ formatPlayersList(yes) }\n` +
                `❌ Не играют: ${ formatPlayersList(no) }\n` +
                `🤔 Думают: ${ formatPlayersList(maybe) }\n\n` +
                `Игроков нужно: ${ session.needed_players }, уже есть: ${ totalYes }`,
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('✅ Играю', `vote:yes:${ session.id }`)],
                        [Markup.button.callback('🤔 Не знаю', `vote:maybe:${ session.id }`)],
                        [Markup.button.callback('❌ Не играю', `vote:no:${ session.id }`)],
                    ]),
                },
            );
        } catch (err) {
            const desc = err?.response?.description || err?.description || err?.message || '';
            if (!desc.includes('message is not modified')) {
                console.error('refreshVoteMessage failed:', err);
            }
        }
    }

    return { totalYes };
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

// 📝 Обработка текстовых сообщений с датой/временем для настройки
bot.use(async (ctx, next) => {
    // Пропускаем если это не текстовое сообщение
    if (!ctx.message || !ctx.message.text) {
        return next();
    }

    const text = ctx.message.text.trim();

    // Пропускаем команды (начинающиеся с /)
    if (text.startsWith('/')) {
        return next();
    }

    // Проверяем, есть ли активный черновик для этого чата
    const draft = db
    .prepare(`SELECT * FROM draft_sessions WHERE chat_id = ?`)
    .get(ctx.chat.id);

    if (!draft) {
        return next(); // Нет активной настройки, пропускаем
    }

    // Проверяем, является ли сообщение датой и временем
    const parts = text.split(' ');
    if (parts.length === 2) {
        const dateInput = parts[0];
        const timeInput = parts[1];

        const validDate = parseDateInput(dateInput);
        const validTime = validateTime(timeInput);

        if (validDate && validTime) {
            try {
                const member = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id);
                const isAdmin = member.status === 'administrator' || member.status === 'creator';

                if (isAdmin) {
                    // Обновляем время в черновике
                    db.prepare(`UPDATE draft_sessions SET date = ?, time = ?, datetime_status = 'tentative' WHERE chat_id = ?`)
                    .run(validDate, validTime, ctx.chat.id);

                    const scheduleLine = formatScheduleLine(validDate, validTime, 'tentative');
                    await ctx.reply(
                        `✅ Предварительное время установлено.\n\n` +
                        `📋 Текущие настройки:\n` +
                        `⚽ Формат: ${draft.format} (нужно ${FORMATS[draft.format]} игроков)\n` +
                        `${scheduleLine}\n\n` +
                        `🚀 Запусти голосование:\n` +
                        `/confirm_vote`
                    );
                    return; // Не продолжаем обработку
                }
            } catch (err) {
                // Игнорируем ошибки проверки прав
            }
        }
    }

    return next(); // Продолжаем обработку для других сообщений
});

// 🏁 Команда выбора формата игры
bot.command('start_vote', async (ctx) => {
    const args = ctx.message.text.split(' ');
    const fmt = args[1];

    if (!fmt || !FORMATS[fmt]) {
        return ctx.reply(
            '⚠️ Укажи формат: /start_vote 6x6 | 7x7 | 8x8 | 9x9\n\n' +
            'Дальше:\n' +
            '1) /set_time сегодня 19:00 (или завтра / 22.09 / 2026-02-21)\n' +
            '2) /confirm_vote',
        );
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

    // Сохраняем формат в черновик
    db.prepare(
        `INSERT OR REPLACE INTO draft_sessions (chat_id, format, datetime_status)
         VALUES (?, ?, 'tentative')`,
    ).run(ctx.chat.id, fmt);

    await ctx.reply(
        `⚽ Формат выбран: ${fmt} (нужно ${FORMATS[fmt]} игроков)\n\n` +
        `📅 Установи предварительное время:\n` +
        `• Командой: /set_time сегодня 19:00\n` +
        `• Или просто напиши: завтра 19:00\n` +
        `• Можно сразу точное: /confirm_datetime 2026-02-21 19:00\n\n` +
        `✅ Запусти голосование:\n` +
        `/confirm_vote`
    );
});

// Алиасы для быстрого выбора формата
bot.command('start_6x6', async (ctx) => {
    const args = ctx.message.text.split(' ');
    // Если переданы дополнительные аргументы, используем старую логику
    if (args[1]) {
        const date = args[1];
        const time = args[2];
        await startVoteWithFormat(ctx, '6x6', date, time);
    } else {
        // Иначе используем новую логику выбора формата
        ctx.message.text = '/start_vote 6x6';
        await bot.handleUpdate({ message: ctx.message });
    }
});
bot.command('start_7x7', async (ctx) => {
    const args = ctx.message.text.split(' ');
    if (args[1]) {
        const date = args[1];
        const time = args[2];
        await startVoteWithFormat(ctx, '7x7', date, time);
    } else {
        ctx.message.text = '/start_vote 7x7';
        await bot.handleUpdate({ message: ctx.message });
    }
});
bot.command('start_8x8', async (ctx) => {
    const args = ctx.message.text.split(' ');
    if (args[1]) {
        const date = args[1];
        const time = args[2];
        await startVoteWithFormat(ctx, '8x8', date, time);
    } else {
        ctx.message.text = '/start_vote 8x8';
        await bot.handleUpdate({ message: ctx.message });
    }
});
bot.command('start_9x9', async (ctx) => {
    const args = ctx.message.text.split(' ');
    if (args[1]) {
        const date = args[1];
        const time = args[2];
        await startVoteWithFormat(ctx, '9x9', date, time);
    } else {
        ctx.message.text = '/start_vote 9x9';
        await bot.handleUpdate({ message: ctx.message });
    }
});

// 🎛 Обработка кнопок голосования
bot.on('callback_query', async (ctx, next) => {
    const [action, vote, sessionId] = (ctx.callbackQuery?.data || '').split(':');

    if (action !== 'vote') {
        return next();
    }

    const activeSession = db
    .prepare(`SELECT *
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

    const { totalYes } = await refreshVoteMessage(sessionId);

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

    // Очищаем черновик если он был
    db.prepare(`DELETE FROM draft_sessions WHERE chat_id = ?`).run(ctx.chat.id);

    await ctx.reply('✅ Голосование завершено. Можно запустить новое: /start_vote 6x6 | 7x7 | 8x8 | 9x9');
});

// 🕐 Установить время для голосования
bot.command('set_time', async (ctx) => {
    const args = ctx.message.text.split(' ');
    const dateInput = args[1];
    const timeInput = args[2];

    if (!dateInput || !timeInput) {
        return ctx.reply(
            '⚠️ Укажи дату и время: /set_time <дата> <время>\n' +
            'Примеры: /set_time сегодня 19:00, /set_time завтра 20:30, /set_time 21.02 19:00',
        );
    }

    const validDate = parseDateInput(dateInput);
    const validTime = validateTime(timeInput);

    if (!validDate) {
        return ctx.reply('⚠️ Неверный формат даты. Примеры: 2026-02-21, 21.02, сегодня, завтра');
    }
    if (!validTime) {
        return ctx.reply('⚠️ Неверный формат времени. Используй HH:MM (например: 19:00)');
    }

    try {
        const member = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id);
        const isAdmin = member.status === 'administrator' || member.status === 'creator';
        if (!isAdmin) {
            return ctx.reply('🚫 Настраивать голосование могут только администраторы.');
        }
    } catch (err) {
        return ctx.reply('🚫 Не удалось проверить права. Попробуйте позже.');
    }

    // Проверяем, есть ли черновик для этого чата
    const draft = db
    .prepare(`SELECT * FROM draft_sessions WHERE chat_id = ?`)
    .get(ctx.chat.id);

    if (!draft) {
        return ctx.reply('ℹ️ Сначала выбери формат командой /start_vote 6x6|7x7|8x8|9x9');
    }

    // Обновляем предварительное время в черновике
    db.prepare(`UPDATE draft_sessions SET date = ?, time = ?, datetime_status = 'tentative' WHERE chat_id = ?`)
    .run(validDate, validTime, ctx.chat.id);

    const scheduleLine = formatScheduleLine(validDate, validTime, 'tentative');
    await ctx.reply(
        `✅ Предварительное время установлено.\n\n` +
        `📋 Текущие настройки:\n` +
        `⚽ Формат: ${draft.format} (нужно ${FORMATS[draft.format]} игроков)\n` +
        `${scheduleLine}\n\n` +
        `Если время уже точное: /confirm_datetime YYYY-MM-DD HH:MM\n\n` +
        `🚀 Запусти голосование:\n` +
        `/confirm_vote`
    );
});

// ⏳ Перевести время в предварительное (для черновика или активного голосования)
bot.command('set_tentative', async (ctx) => {
    const args = ctx.message.text.split(' ');
    const dateInput = args[1];
    const timeInput = args[2];

    const validDate = dateInput ? parseDateInput(dateInput) : null;
    const validTime = timeInput ? validateTime(timeInput) : null;

    if (dateInput && !validDate) {
        return ctx.reply('⚠️ Неверный формат даты. Примеры: 2026-02-21, 21.02, сегодня, завтра');
    }
    if (timeInput && !validTime) {
        return ctx.reply('⚠️ Неверный формат времени. Используй HH:MM (например: 19:00)');
    }

    try {
        const member = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id);
        const isAdmin = member.status === 'administrator' || member.status === 'creator';
        if (!isAdmin) {
            return ctx.reply('🚫 Изменять статус времени могут только администраторы.');
        }
    } catch (err) {
        return ctx.reply('🚫 Не удалось проверить права. Попробуйте позже.');
    }

    const draft = db
    .prepare(`SELECT * FROM draft_sessions WHERE chat_id = ?`)
    .get(ctx.chat.id);

    if (draft) {
        const nextDate = dateInput ? validDate : draft.date;
        const nextTime = timeInput ? validTime : draft.time;

        db.prepare(`UPDATE draft_sessions SET date = ?, time = ?, datetime_status = 'tentative' WHERE chat_id = ?`)
        .run(nextDate, nextTime, ctx.chat.id);

        const scheduleLine = formatScheduleLine(nextDate, nextTime, 'tentative');
        return ctx.reply(
            `⏳ Время отмечено как предварительное.\n\n` +
            `📋 Текущие настройки:\n` +
            `⚽ Формат: ${draft.format} (нужно ${FORMATS[draft.format]} игроков)\n` +
            `${scheduleLine}\n\n` +
            `🚀 Запусти голосование:\n` +
            `/confirm_vote`,
        );
    }

    const activeSession = db
    .prepare(`SELECT id, date, time
              FROM sessions
              WHERE chat_id = ?
                AND is_active = 1`)
    .get(ctx.chat.id);

    if (!activeSession) {
        return ctx.reply('ℹ️ Нет ни черновика, ни активного голосования. Начни с /start_vote');
    }

    const nextDate = dateInput ? validDate : activeSession.date;
    const nextTime = timeInput ? validTime : activeSession.time;

    db.prepare(`UPDATE sessions SET date = ?, time = ?, datetime_status = 'tentative' WHERE id = ?`)
    .run(nextDate, nextTime, activeSession.id);

    await refreshVoteMessage(activeSession.id);
    const scheduleLine = formatScheduleLine(nextDate, nextTime, 'tentative');
    return ctx.reply(`⏳ В активном голосовании время стало предварительным.\n${scheduleLine}`);
});

// ✅ Подтвердить точную дату и время (для черновика или активного голосования)
bot.command('confirm_datetime', async (ctx) => {
    const args = ctx.message.text.split(' ');
    const dateInput = args[1];
    const timeInput = args[2];

    if (!dateInput || !timeInput) {
        return ctx.reply('⚠️ Укажи точные дату и время: /confirm_datetime YYYY-MM-DD HH:MM');
    }

    const validDate = parseDateInput(dateInput);
    const validTime = validateTime(timeInput);

    if (!validDate) {
        return ctx.reply('⚠️ Неверный формат даты. Примеры: 2026-02-21, 21.02, сегодня, завтра');
    }
    if (!validTime) {
        return ctx.reply('⚠️ Неверный формат времени. Используй HH:MM (например: 19:00)');
    }

    try {
        const member = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id);
        const isAdmin = member.status === 'administrator' || member.status === 'creator';
        if (!isAdmin) {
            return ctx.reply('🚫 Подтверждать дату/время могут только администраторы.');
        }
    } catch (err) {
        return ctx.reply('🚫 Не удалось проверить права. Попробуйте позже.');
    }

    const draft = db
    .prepare(`SELECT * FROM draft_sessions WHERE chat_id = ?`)
    .get(ctx.chat.id);

    if (draft) {
        db.prepare(`UPDATE draft_sessions SET date = ?, time = ?, datetime_status = 'confirmed' WHERE chat_id = ?`)
        .run(validDate, validTime, ctx.chat.id);

        const scheduleLine = formatScheduleLine(validDate, validTime, 'confirmed');
        return ctx.reply(
            `✅ Точное время подтверждено.\n\n` +
            `📋 Текущие настройки:\n` +
            `⚽ Формат: ${draft.format} (нужно ${FORMATS[draft.format]} игроков)\n` +
            `${scheduleLine}\n\n` +
            `🚀 Запусти голосование:\n` +
            `/confirm_vote`,
        );
    }

    const activeSession = db
    .prepare(`SELECT id
              FROM sessions
              WHERE chat_id = ?
                AND is_active = 1`)
    .get(ctx.chat.id);

    if (!activeSession) {
        return ctx.reply('ℹ️ Нет ни черновика, ни активного голосования. Начни с /start_vote');
    }

    db.prepare(`UPDATE sessions SET date = ?, time = ?, datetime_status = 'confirmed' WHERE id = ?`)
    .run(validDate, validTime, activeSession.id);

    await refreshVoteMessage(activeSession.id);
    const scheduleLine = formatScheduleLine(validDate, validTime, 'confirmed');
    return ctx.reply(`✅ В активном голосовании дата/время подтверждены.\n${scheduleLine}`);
});

// 🚫 Отменить настройку голосования
bot.command('cancel_setup', async (ctx) => {
    try {
        const member = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id);
        const isAdmin = member.status === 'administrator' || member.status === 'creator';
        if (!isAdmin) {
            return ctx.reply('🚫 Управлять настройками могут только администраторы.');
        }
    } catch (err) {
        return ctx.reply('🚫 Не удалось проверить права. Попробуйте позже.');
    }

    const deleted = db.prepare(`DELETE FROM draft_sessions WHERE chat_id = ?`).run(ctx.chat.id);
    if (deleted.changes > 0) {
        await ctx.reply('✅ Настройка голосования отменена. Начни заново командой /start_vote');
    } else {
        await ctx.reply('ℹ️ Нет активной настройки для отмены.');
    }
});

// ✅ Запустить голосование из черновика
bot.command('confirm_vote', async (ctx) => {
    try {
        const member = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id);
        const isAdmin = member.status === 'administrator' || member.status === 'creator';
        if (!isAdmin) {
            return ctx.reply('🚫 Запускать голосование могут только администраторы.');
        }
    } catch (err) {
        return ctx.reply('🚫 Не удалось проверить права. Попробуйте позже.');
    }

    // Проверяем активное голосование
    const existingActive = db
    .prepare(`SELECT id, format, needed_players, date, time, datetime_status
              FROM sessions
              WHERE chat_id = ?
                AND is_active = 1`)
    .get(ctx.chat.id);
    if (existingActive) {
        const scheduleLine = formatScheduleLine(existingActive.date, existingActive.time, existingActive.datetime_status);
        return ctx.reply(
            `⚠️ В этом чате уже запущено голосование (формат: ${ existingActive.format }).\n${scheduleLine}\n` +
            `Чтобы начать новое, завершите текущее командой /end_vote.`,
        );
    }

    // Получаем черновик
    const draft = db
    .prepare(`SELECT * FROM draft_sessions WHERE chat_id = ?`)
    .get(ctx.chat.id);

    if (!draft || !draft.format) {
        return ctx.reply('ℹ️ Сначала выбери формат командой /start_vote 6x6|7x7|8x8|9x9');
    }

    // Создаем сессию голосования
    const draftStatus = resolveDateTimeStatus(draft.datetime_status, draft.date, draft.time);
    const info = db
    .prepare(
        `INSERT INTO sessions (chat_id, format, needed_players, is_active, author_id, date, time, datetime_status)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
    )
    .run(
        ctx.chat.id,
        draft.format,
        FORMATS[draft.format],
        ctx.from.id.toString(),
        draft.date,
        draft.time,
        draftStatus,
    );
    const sessionId = info.lastInsertRowid;

    // Очищаем черновик
    db.prepare(`DELETE FROM draft_sessions WHERE chat_id = ?`).run(ctx.chat.id);

    const scheduleLine = formatScheduleLine(draft.date, draft.time, draftStatus);

    const message = await ctx.reply(
        `⚽ Голосование началось!\nФормат: ${draft.format} (нужно ${FORMATS[draft.format]} игроков)\n${scheduleLine}\n\nКто играет?`,
        Markup.inlineKeyboard([
            [Markup.button.callback('✅ Играю', `vote:yes:${ sessionId }`)],
            [Markup.button.callback('❌ Не играю', `vote:no:${ sessionId }`)],
            [Markup.button.callback('🤔 Не знаю', `vote:maybe:${ sessionId }`)],
        ]),
    );

    // Сохраняем ID сообщения голосования
    db.prepare(`UPDATE sessions SET message_id = ? WHERE id = ?`).run(message.message_id, sessionId);

    await sendVoteStartNotification(ctx.chat.id, sessionId, message.message_id);
});

// 🕐 Изменить дату и время голосования
bot.command('set_datetime', async (ctx) => {
    const args = ctx.message.text.split(' ');
    const dateInput = args[1];
    const timeInput = args[2];

    if (!dateInput && !timeInput) {
        return ctx.reply(
            '⚠️ Укажи дату и/или время: /set_datetime <дата> <время>\n' +
            'Примеры: /set_datetime завтра 19:30, /set_datetime 2026-02-21 19:30',
        );
    }

    const validDate = dateInput ? parseDateInput(dateInput) : null;
    const validTime = timeInput ? validateTime(timeInput) : null;

    if (dateInput && !validDate) {
        return ctx.reply('⚠️ Неверный формат даты. Примеры: 2026-02-21, 21.02, сегодня, завтра');
    }
    if (timeInput && !validTime) {
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
    .prepare(`SELECT id, format, date, time, datetime_status
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

    await refreshVoteMessage(activeSession.id);
    const scheduleLine = formatScheduleLine(
        validDate || activeSession.date,
        validTime || activeSession.time,
        activeSession.datetime_status,
    );
    await ctx.reply(`✅ Дата/время обновлены.\n${scheduleLine}`);
});

// 🔔 Напоминания каждые 2 часа
cron.schedule('0 */2 * * *', async () => {
    const activeSessions = db
    .prepare(`SELECT id, chat_id, message_id
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

        // Проверяем, существуют ли новые колонки
        let membersQuery = `SELECT id`;
        try {
            db.prepare(`SELECT first_name FROM members LIMIT 1`).get();
            membersQuery += `, username, first_name, last_name`;
        } catch (e) {
            // Если колонки не существуют, используем старый формат
            membersQuery += `, username`;
        }
        membersQuery += ` FROM members`;

        const members = db.prepare(membersQuery).all();

        const notVotedMembers = members.filter((m) => !votedUserIds.includes(m.id));
        const mentions = notVotedMembers
        .map(formatPlayerMention)
        .filter((s) => s.length > 0)
        .join(', ');

        if (mentions.length > 0) {
            // Создаем ссылку на голосование
            let voteLink = '';
            if (session.message_id) {
                const chatId = session.chat_id.toString().replace('-', ''); // Убираем минус для супергрупп
                voteLink = ` [Голосование](https://t.me/c/${chatId}/${session.message_id})`;
            }

            await bot.telegram.sendMessage(
                session.chat_id,
                `⏰ Напоминание! Проголосуйте, если ещё не отметились.${voteLink}\n` +
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

console.log('🚀 Запуск бота...');

// ▶️ Запуск
console.log('🔗 Подключение к Telegram API...');
bot.launch().then(() => {
    console.log('✅ Бот успешно запущен и подключен к Telegram!');
}).catch((err) => {
    console.error('❌ Ошибка запуска бота:', err.message);
    console.error('Проверь BOT_TOKEN в переменных окружения');
    process.exit(1);
});
