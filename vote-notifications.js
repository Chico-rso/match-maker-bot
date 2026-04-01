export function buildVoteNotificationText({
    introLine,
    voteMessageLink,
    mentions,
    linkLabel = 'Текущее голосование',
}) {
    const lines = [introLine];

    if (voteMessageLink) {
        lines.push(`🔗 [${linkLabel}](${voteMessageLink})`);
    }

    if (mentions) {
        if (voteMessageLink) {
            lines.push('');
        }
        lines.push(mentions);
    }

    return lines.join('\n');
}
