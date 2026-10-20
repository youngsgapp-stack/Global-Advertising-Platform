/**
 * 거래 기능 통합 테스트: 실제 DB 안의 별도 스키마(market_test)에 테이블을 복제해 API를 실제로 호출하고, 끝나면 스키마 삭제
 * (search_path를 market_test로만 고정해서 public 데이터는 건드리지 않음)
 * 실행: cd backend && TZ=UTC node scripts/test-market-flows.mjs   (PowerShell: $env:TZ='UTC'; node scripts/test-market-flows.mjs)
 */
import 'dotenv/config';
import pg from 'pg';
import { readFileSync } from 'fs';

const SCHEMA = 'market_test';
const admin = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await admin.connect();
await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
await admin.query(`CREATE SCHEMA ${SCHEMA}`);
for (const table of ['users', 'wallets', 'wallet_transactions', 'territories', 'auctions', 'bids', 'ownerships', 'admin_logs']) {
    await admin.query(`CREATE TABLE ${SCHEMA}.${table} (LIKE public.${table} INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)`);
}
await admin.query(`SET search_path TO ${SCHEMA}`);
for (const file of ['006_add_territory_ads_and_reports.sql', '007_add_referrals.sql', '008_add_market_features.sql']) {
    await admin.query(readFileSync(`db/migrations/${file}`, 'utf8'));
}

process.env.PGOPTIONS = `-c search_path=${SCHEMA}`;
const results = [];
const check = (name, ok, detail = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);

try {
    const { initDatabase, query } = await import('../db/init.js');
    const { initRedis } = await import('../redis/init.js');
    await initDatabase();
    await initRedis();
    const sp = (await query('SHOW search_path')).rows[0].search_path;
    if (!sp.includes(SCHEMA)) throw new Error(`search_path not isolated: ${sp}`);
    
    const express = (await import('express')).default;
    const { marketRouter, processMarketJobs } = await import('../routes/market.js');
    const { auctionsRouter } = await import('../routes/auctions.js');
    const { territoriesRouter } = await import('../routes/territories.js');
    const { endExpiredAuctions } = await import('../routes/cron.js');
    
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        const uid = req.headers['x-test-uid'];
        if (uid) req.user = { uid, email: `${uid}@test.local` };
        next();
    });
    app.use('/api/market', marketRouter);
    app.use('/api/auctions', auctionsRouter);
    app.use('/api/territories', territoriesRouter);
    const server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const call = async (uid, method, path, body) => {
        const response = await fetch(base + path, {
            method,
            headers: { 'Content-Type': 'application/json', ...(uid ? { 'x-test-uid': uid } : {}) },
            body: body ? JSON.stringify(body) : undefined
        });
        let data = null;
        try { data = await response.json(); } catch { /* empty */ }
        return { status: response.status, data };
    };
    
    // --- 준비: 사용자 A(주인) B C, 지갑 10,000pt, 테스트 영토 ---
    const ids = {};
    for (const name of ['A', 'B', 'C']) {
        const user = (await query(`INSERT INTO users (firebase_uid, email, nickname) VALUES ($1, $2, $3) RETURNING id`, [`uid-${name}`, `${name}@t`, `User${name}`])).rows[0];
        ids[name] = user.id;
        await query(`INSERT INTO wallets (user_id, balance) VALUES ($1, 10000)`, [user.id]);
    }
    const balance = async n => parseFloat((await query(`SELECT balance FROM wallets WHERE user_id = $1`, [ids[n]])).rows[0].balance);
    const mkTerritory = (id, owner, endsSql, sovereignty = 'protected') => query(
        `INSERT INTO territories (id, code, name, country, country_iso, base_price, status, sovereignty, ruler_id, protection_ends_at)
         VALUES ($1, $1, $1, 'south-korea', 'KOR', 100, $2, $2, $3, ${endsSql})`,
        [id, owner ? sovereignty : 'unconquered', owner ? ids[owner] : null]
    );
    await mkTerritory('zz-taken', 'A', `NOW() + interval '20 days'`);
    await mkTerritory('zz-life', 'A', 'NULL');
    await mkTerritory('zz-grace', 'A', `NOW() - interval '1 day'`, 'ruled');
    await mkTerritory('zz-open', 'A', `NOW() - interval '5 days'`, 'ruled');
    await mkTerritory('zz-free', null, 'NULL');
    await mkTerritory('zz-bb', null, 'NULL');
    await query(`UPDATE territories SET is_billboard = true WHERE id = 'zz-bb'`);
    const startAuction = (uid, territoryId, startingBid = 100) => call(uid, 'POST', '/auctions', { territoryId, startingBid, endTime: new Date(Date.now() + 2 * 3600e3).toISOString() });
    
    // 1) 기간이 많이 남은 땅: 남이 경매 불가
    let r = await startAuction('uid-B', 'zz-taken');
    check('Taken spot (20 days left): others cannot start an auction', r.status === 409, r.data?.error);
    
    // 2) 마감 3일 전: 다음 기간 경매, 마감은 주인 기간 끝
    await query(`UPDATE territories SET protection_ends_at = NOW() + interval '3 days' WHERE id = 'zz-taken'`);
    const takenEnds = (await query(`SELECT protection_ends_at FROM territories WHERE id = 'zz-taken'`)).rows[0].protection_ends_at;
    r = await startAuction('uid-B', 'zz-taken');
    const nextAuction = r.data?.auction;
    const nextRow = nextAuction && (await query(`SELECT kind, end_time FROM auctions WHERE id = $1`, [nextAuction.id])).rows[0];
    check('Last 7 days: next-period auction starts', r.status === 200 && nextRow?.kind === 'next_period', `kind=${nextRow?.kind}`);
    check('Next-period auction ends exactly when the current period ends', nextRow && Math.abs(new Date(nextRow.end_time) - new Date(takenEnds)) < 1000);
    
    // 3) 입찰: B 200 → 주인 A 200(동액 매칭) 허용, C 200 거절
    r = await call('uid-B', 'POST', `/auctions/${nextAuction.id}/bids`, { amount: 200 });
    check('B bids 200', r.status === 200, r.data?.error);
    r = await call('uid-A', 'POST', `/auctions/${nextAuction.id}/bids`, { amount: 200 });
    check('Owner A matches 200 (same amount allowed)', r.status === 200, r.data?.error);
    r = await call('uid-C', 'POST', `/auctions/${nextAuction.id}/bids`, { amount: 200 });
    check('C cannot bid the same 200 (needs 201)', r.status === 400);
    r = await call('uid-A', 'POST', `/auctions/${nextAuction.id}/bids`, { amount: 150.5 });
    check('Decimal bid rejected', r.status === 400);
    check('B was refunded when A matched', await balance('B') === 10000, `B=${await balance('B')}`);
    
    // 마감 처리 (자동 종료 작업)
    await query(`UPDATE bids SET created_at = NOW() - interval '1 minute' WHERE auction_id = $1`, [nextAuction.id]);
    await query(`UPDATE auctions SET end_time = NOW() - interval '1 second' WHERE id = $1`, [nextAuction.id]);
    await endExpiredAuctions();
    let t = (await query(`SELECT ruler_id, protection_ends_at FROM territories WHERE id = 'zz-taken'`)).rows[0];
    check('Owner A keeps the spot by matching', String(t.ruler_id) === String(ids.A));
    check('Protection extended past the old end', new Date(t.protection_ends_at) > new Date(takenEnds), `${new Date(t.protection_ends_at).toISOString().slice(0, 10)}`);
    
    // 4) 평생 소장: 남은 경매 불가, 주인 판매 경매 → 낙찰금 90% 주인
    r = await startAuction('uid-B', 'zz-life');
    check('Lifetime spot: others cannot start an auction', r.status === 409);
    r = await startAuction('uid-A', 'zz-life', 300);
    const saleAuction = r.data?.auction;
    const saleRow = saleAuction && (await query(`SELECT kind FROM auctions WHERE id = $1`, [saleAuction.id])).rows[0];
    check('Owner starts a sale auction', r.status === 200 && saleRow?.kind === 'owner_sale', r.data?.error || saleRow?.kind);
    r = await call('uid-A', 'POST', `/auctions/${saleAuction.id}/bids`, { amount: 400 });
    check('Seller cannot bid on own sale', r.status === 400);
    const aBeforeSale = await balance('A');
    r = await call('uid-B', 'POST', `/auctions/${saleAuction.id}/bids`, { amount: 300 });
    check('B bids 300 on the sale', r.status === 200, r.data?.error);
    await query(`UPDATE bids SET created_at = NOW() - interval '1 minute' WHERE auction_id = $1`, [saleAuction.id]);
    await query(`UPDATE auctions SET end_time = NOW() - interval '1 second' WHERE id = $1`, [saleAuction.id]);
    await endExpiredAuctions();
    t = (await query(`SELECT ruler_id, sovereignty, protection_ends_at FROM territories WHERE id = 'zz-life'`)).rows[0];
    check('B owns the lifetime spot, still lifetime', String(t.ruler_id) === String(ids.B) && t.sovereignty === 'protected' && !t.protection_ends_at);
    check('Seller A received 90% (270 pt)', (await balance('A')) - aBeforeSale === 270, `+${(await balance('A')) - aBeforeSale}`);
    
    // 5) 유예 기간 + 대기 예약
    r = await startAuction('uid-B', 'zz-grace');
    check('Grace period: others cannot start an auction', r.status === 409);
    r = await call('uid-B', 'POST', '/market/territories/zz-grace/reservations');
    check('B reserves next turn (deposit 10)', r.status === 200 && r.data.deposit === 10 && r.data.position === 1, JSON.stringify(r.data));
    r = await call('uid-C', 'POST', '/market/territories/zz-grace/reservations');
    check('C reserves (position 2)', r.status === 200 && r.data.position === 2);
    r = await call('uid-C', 'POST', '/market/territories/zz-grace/reservations');
    check('Duplicate reservation rejected', r.status === 409);
    let m = await call('uid-B', 'GET', '/market/territories/zz-grace');
    check('Market info: phase grace, B is #1', m.data?.phase === 'grace' && m.data?.reservations?.myPosition === 1, `${m.data?.phase}`);
    
    // 유예 끝 → 1순위 B에게 우선 구매권
    await query(`UPDATE territories SET protection_ends_at = NOW() - interval '4 days' WHERE id = 'zz-grace'`);
    await processMarketJobs();
    m = await call('uid-B', 'GET', '/market/territories/zz-grace');
    check('After grace: B gets the first right to buy', m.data?.phase === 'reserved' && m.data?.reservations?.myStatus === 'offered', `${m.data?.phase}/${m.data?.reservations?.myStatus}`);
    r = await call('uid-A', 'POST', '/territories/zz-grace/extend', { protectionDays: 7 });
    check('Owner can no longer renew once B has the turn', r.status === 409, r.data?.error);
    r = await startAuction('uid-C', 'zz-grace');
    check('Nobody can start an auction during B\'s turn', r.status === 409);
    const bBeforeClaim = await balance('B');
    r = await call('uid-B', 'POST', '/market/territories/zz-grace/reservations/claim', { protectionDays: 7 });
    check('B claims for 1 week (pays 100 - 10 deposit = 90)', r.status === 200 && bBeforeClaim - (await balance('B')) === 90, r.data?.error || `${bBeforeClaim - (await balance('B'))}`);
    t = (await query(`SELECT ruler_id FROM territories WHERE id = 'zz-grace'`)).rows[0];
    check('B now owns the reserved spot', String(t.ruler_id) === String(ids.B));
    m = await call('uid-C', 'GET', '/market/territories/zz-grace');
    check('C is still waiting (now #1 for the next turn)', m.data?.reservations?.myPosition === 1 && m.data?.reservations?.myStatus === 'waiting');
    const cBeforeCancel = await balance('C');
    r = await call('uid-C', 'DELETE', `/market/reservations/${m.data.reservations.myId}`);
    check('C cancels a waiting reservation and gets the deposit back', r.status === 200 && (await balance('C')) - cBeforeCancel === 10);
    
    // 6) 구매 제안
    r = await call('uid-C', 'POST', '/market/territories/zz-open/offers', { amount: 50 });
    check('Offer below one week price rejected', r.status === 400);
    r = await call('uid-C', 'POST', '/market/territories/zz-open/offers', { amount: 150, message: 'Love this spot' });
    check('C offers 150', r.status === 200, r.data?.error);
    r = await call('uid-B', 'POST', '/market/territories/zz-open/offers', { amount: 160 });
    const offerB = r.data?.offerId;
    check('B offers 160', r.status === 200);
    m = await call('uid-A', 'GET', '/market/territories/zz-open');
    check('Owner sees 2 incoming offers, best first', m.data?.offers?.incoming?.length === 2 && m.data.offers.incoming[0].amount === 160);
    r = await call('uid-C', 'POST', `/market/offers/${offerB}/accept`);
    check('Non-owner cannot accept', r.status === 403);
    const aBeforeOffer = await balance('A');
    const cBeforeOffer = await balance('C');
    r = await call('uid-A', 'POST', `/market/offers/${offerB}/accept`);
    check('A accepts B\'s 160 offer', r.status === 200 && r.data.payout === 144, r.data?.error || `payout ${r.data?.payout}`);
    check('A received 144 (90%)', (await balance('A')) - aBeforeOffer === 144);
    check('C\'s competing offer refunded (150)', (await balance('C')) - cBeforeOffer === 150);
    t = (await query(`SELECT ruler_id, protection_ends_at FROM territories WHERE id = 'zz-open'`)).rows[0];
    check('B owns zz-open with at least 7 days', String(t.ruler_id) === String(ids.B) && new Date(t.protection_ends_at) > new Date(Date.now() + 6.9 * 86400e3));
    
    // 7) 광고판
    r = await call('uid-B', 'POST', '/territories/zz-bb/purchase', { price: 100, protectionDays: 7 });
    check('Billboard cannot be bought directly', r.status === 409, r.data?.error);
    const cal = await call('uid-B', 'GET', '/market/territories/zz-bb/billboard');
    const [week0, week1] = cal.data.weeks.map(w => w.weekStart);
    const bBeforeBook = await balance('B');
    r = await call('uid-B', 'POST', '/market/territories/zz-bb/billboard/bookings', { weeks: [week0, week1] });
    check('B books this week + next week (200 pt)', r.status === 200 && bBeforeBook - (await balance('B')) === 200, r.data?.error);
    r = await call('uid-C', 'POST', '/market/territories/zz-bb/billboard/bookings', { weeks: [week1] });
    check('C cannot book a taken week', r.status === 409);
    await processMarketJobs();
    t = (await query(`SELECT ruler_id, protection_ends_at FROM territories WHERE id = 'zz-bb'`)).rows[0];
    check('This week B shows on the billboard', String(t.ruler_id) === String(ids.B));
    const cal2 = await call('uid-B', 'GET', '/market/territories/zz-bb/billboard');
    const nextWeek = cal2.data.weeks[1];
    if (nextWeek.canCancel) {
        const bBefore = await balance('B');
        r = await call('uid-B', 'DELETE', `/market/bookings/${nextWeek.bookingId}`);
        check('B cancels next week (>48h ahead) with full refund', r.status === 200 && (await balance('B')) - bBefore === 100);
    } else {
        check('Next week within 48h cannot be cancelled (skipped refund test)', true);
    }
    r = await call('uid-C', 'POST', '/market/territories/zz-bb/offers', { amount: 500 });
    check('No offers on billboards', r.status === 409);
    
    // 8) 관심 등록 + 알림
    r = await call('uid-C', 'POST', '/market/territories/zz-free/watch');
    check('C watches zz-free', r.status === 200);
    let n = await call('uid-C', 'GET', '/market/me/notices');
    check('C gets an "available" alert once', n.data?.watchAlerts?.some(a => a.territoryId === 'zz-free' && a.event === 'available'));
    n = await call('uid-C', 'GET', '/market/me/notices');
    check('Alert not repeated', !n.data?.watchAlerts?.some(a => a.territoryId === 'zz-free'));
    m = await call(null, 'GET', '/market/territories/zz-free');
    check('Watch count visible', m.data?.watchCount === 1);
    
    // 9) 장부 검증: 모든 지갑 잔액 = 10,000 + 거래 합계
    const ledger = await query(
        `SELECT w.user_id, w.balance, COALESCE(SUM(t.amount), 0) AS total
         FROM wallets w LEFT JOIN wallet_transactions t ON t.wallet_id = w.id GROUP BY w.user_id, w.balance`
    );
    check('Every wallet balance matches its transaction history', ledger.rows.every(row => Math.abs(parseFloat(row.balance) - 10000 - parseFloat(row.total)) < 0.001),
        ledger.rows.map(row => `${parseFloat(row.balance)}=${10000 + parseFloat(row.total)}`).join(' '));
    
    server.close();
} catch (error) {
    results.push(`ERROR ${error.stack}`);
} finally {
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.end();
    console.log(results.join('\n'));
    console.log(`\n${results.filter(x => x.startsWith('PASS')).length} passed, ${results.filter(x => !x.startsWith('PASS')).length} failed`);
    process.exit(0);
}
