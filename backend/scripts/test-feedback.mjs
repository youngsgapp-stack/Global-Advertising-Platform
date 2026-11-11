/**
 * 피드백 저장 테스트 (로컬 테스트 DB에서 실행)
 */
import 'dotenv/config';

const results = [];
const check = (name, ok, detail = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);

try {
    const { initDatabase, query } = await import('../db/init.js');
    await initDatabase();
    const express = (await import('express')).default;
    const { feedbackRouter } = await import('../routes/feedback.js');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = req.headers['x-test-uid'] ? { uid: req.headers['x-test-uid'] } : null; next(); });
    app.use('/api/feedback', feedbackRouter);
    const server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}/api/feedback`;
    const post = (body, uid) => fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(uid ? { 'x-test-uid': uid } : {}) }, body: JSON.stringify(body) });
    
    await query(`INSERT INTO users (firebase_uid, email, nickname) VALUES ('uid-F', 'f@t', 'UserF')`);
    let r = await post({ type: 'bug', title: 'Map is slow', message: "It's slow on my phone <b>", rating: 4, pageUrl: 'https://x' });
    check('Guest can send feedback', r.status === 200, String(r.status));
    r = await post({ type: 'feature', title: 'Idea', message: 'Dark mode', rating: 9 }, 'uid-F');
    check('Signed-in user can send feedback', r.status === 200, String(r.status));
    r = await post({ type: 'general', title: '', message: 'x' });
    check('Empty title rejected', r.status === 400, String(r.status));
    const rows = (await query(`SELECT f.type, f.title, f.message, f.rating, u.nickname FROM feedback f LEFT JOIN users u ON u.id = f.user_id ORDER BY f.id`)).rows;
    check('Stored as plain text (escaping happens when shown)', rows[0]?.message === "It's slow on my phone <b>");
    check('Invalid rating stored as empty', rows[1]?.rating === null);
    check('Signed-in feedback linked to the user', rows[1]?.nickname === 'UserF');
    for (let i = 0; i < 5; i++) r = await post({ title: 't', message: 'm' });
    check('Rate limited after 5 per 10 minutes', r.status === 429, String(r.status));
    server.close();
} catch (error) {
    results.push(`ERROR ${error.stack}`);
} finally {
    console.log(results.join('\n'));
    console.log(`\n${results.filter(x => x.startsWith('PASS')).length} passed, ${results.filter(x => !x.startsWith('PASS')).length} failed`);
    process.exit(0);
}
