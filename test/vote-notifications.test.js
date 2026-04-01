import test from 'node:test';
import assert from 'node:assert/strict';

import { buildVoteNotificationText } from '../vote-notifications.js';

test('places the vote link on its own line before the player list', () => {
    const text = buildVoteNotificationText({
        introLine: '📢 Голосование запущено! Пожалуйста, отметьтесь.',
        voteMessageLink: 'https://t.me/c/123/456',
        mentions: '@alice, @bob',
    });

    assert.equal(
        text,
        '📢 Голосование запущено! Пожалуйста, отметьтесь.\n🔗 [Текущее голосование](https://t.me/c/123/456)\n\n@alice, @bob',
    );
});

test('omits the vote link line when there is no vote message link', () => {
    const text = buildVoteNotificationText({
        introLine: '⏰ Напоминание! Проголосуйте, если ещё не отметились.',
        voteMessageLink: '',
        mentions: '@alice, @bob',
    });

    assert.equal(
        text,
        '⏰ Напоминание! Проголосуйте, если ещё не отметились.\n@alice, @bob',
    );
});
