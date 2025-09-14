import 'dotenv/config';
import express from 'express';
import { Telegraf, Markup } from 'telegraf';
import cron from 'node-cron';
import Database from 'better-sqlite3';

const app = express();

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
    console.error('BOT_TOKEN is required. Set it in environment or .env');
    process.exit(1);
}
const PORT = process.env.PORT || 3000;

// ⚽ Конфигурация форматов
const FORMATS = {
    '6x6': 12,
    '7x7': 14,
    '8x8': 16,
    '9x9': 18,
};

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
         INTEGER
     )`,
).run();

// Миграция: добавляем автора голосования, если столбца нет
try {
    db.prepare(`ALTER TABLE sessions ADD COLUMN author_id TEXT`).run();
} catch (e) {
    // столбец уже существует — игнорируем
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
    { command: 'start_vote', description: 'Запустить голосование: /start_vote 6x6|7x7|8x8|9x9' },
    { command: 'start_6x6', description: 'Запустить голосование 6x6' },
    { command: 'start_7x7', description: 'Запустить голосование 7x7' },
    { command: 'start_8x8', description: 'Запустить голосование 8x8' },
    { command: 'start_9x9', description: 'Запустить голосование 9x9' },
    { command: 'end_vote', description: 'Завершить текущее голосование' },
]);

// Хелпер старта голосования c проверками
async function startVoteWithFormat(ctx, fmt) {
    if (!fmt || !FORMATS[fmt]) {
        return ctx.reply('⚠️ Укажи формат: /start_vote 6x6 | 7x7 | 8x8 | 9x9');
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
    .prepare(`SELECT id, format, needed_players
              FROM sessions
              WHERE chat_id = ?
                AND is_active = 1`)
    .get(ctx.chat.id);
    if (existingActive) {
        return ctx.reply(
            `⚠️ В этом чате уже запущено голосование (формат: ${ existingActive.format }).\n` +
            `Чтобы начать новое, завершите текущее командой /end_vote.`,
        );
    }
    const info = db
    .prepare(
        `INSERT INTO sessions (chat_id, format, needed_players, is_active, author_id)
         VALUES (?, ?, ?, 1, ?)`,
    )
    .run(ctx.chat.id, fmt, FORMATS[fmt], ctx.from.id.toString());
    const sessionId = info.lastInsertRowid;
    return ctx.reply(
        `⚽ Голосование началось!\nФормат: ${ fmt } (нужно ${ FORMATS[fmt] } игроков)\n\nКто играет?`,
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
        const username = member.username || id;
        db.prepare(
            `INSERT
            OR REPLACE INTO members (id, username) VALUES (?, ?)`,
        ).run(id, username);
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
    await startVoteWithFormat(ctx, fmt);
});

// Алиасы для быстрого старта через слэш
bot.command('start_6x6', async (ctx) => startVoteWithFormat(ctx, '6x6'));
bot.command('start_7x7', async (ctx) => startVoteWithFormat(ctx, '7x7'));
bot.command('start_8x8', async (ctx) => startVoteWithFormat(ctx, '8x8'));
bot.command('start_9x9', async (ctx) => startVoteWithFormat(ctx, '9x9'));

// 🎛 Обработка кнопок голосования
bot.on('callback_query', async (ctx) => {
    const [action, vote, sessionId] = ctx.callbackQuery.data.split(':');
    
    if (action !== 'vote') return;
    
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
    const username = ctx.from.username || userId;
    
    db.prepare(
        `INSERT
        OR REPLACE INTO members (id, username) VALUES (?, ?)`,
    ).run(userId, username);
    
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
    .prepare(`SELECT username
              FROM votes v
                       JOIN members m ON v.user_id = m.id
              WHERE v.vote = 'yes'
                AND v.session_id = ?`)
    .all(sessionId)
    .map((r) => r.username);
    
    const no = db
    .prepare(`SELECT username
              FROM votes v
                       JOIN members m ON v.user_id = m.id
              WHERE v.vote = 'no'
                AND v.session_id = ?`)
    .all(sessionId)
    .map((r) => r.username);
    
    const maybe = db
    .prepare(`SELECT username
              FROM votes v
                       JOIN members m ON v.user_id = m.id
              WHERE v.vote = 'maybe'
                AND v.session_id = ?`)
    .all(sessionId)
    .map((r) => r.username);
    
    const totalYes = yes.length;
    
    await ctx.editMessageText(
        `⚽ Формат: ${ activeSession.format }\n` +
        `✅ Играют: ${ yes.join(', ') || 'нет' }\n` +
        `❌ Не играют: ${ no.join(', ') || 'нет' }\n` +
        `🤔 Думают: ${ maybe.join(', ') || 'нет' }\n\n` +
        `Игроков нужно: ${ activeSession.needed_players }, уже есть: ${ totalYes }`,
        Markup.inlineKeyboard([
            [Markup.button.callback('✅ Играю', `vote:yes:${ sessionId }`)],
            [Markup.button.callback('❌ Не играю', `vote:no:${ sessionId }`)],
            [Markup.button.callback('🤔 Не знаю', `vote:maybe:${ sessionId }`)],
        ]),
    );
    
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
        
        const members = db.prepare(`SELECT id, username FROM members`).all();
        
        const notVotedMembers = members.filter((m) => !votedUserIds.includes(m.id));
        const mentions = notVotedMembers
        .map((m) => m.username ? `@${ m.username }` : '')
        .filter((s) => s.length > 0)
        .join(' ');
        
        if (mentions.length > 0) {
            await bot.telegram.sendMessage(
                session.chat_id,
                `⏰ Напоминание! Проголосуйте, если ещё не отметились.\n` +
                mentions,
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
