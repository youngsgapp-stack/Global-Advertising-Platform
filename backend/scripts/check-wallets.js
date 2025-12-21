/**
 * Wallets 최종 상태 확인 스크립트
 */

import 'dotenv/config';
import { query, initDatabase } from '../db/init.js';

await initDatabase();

const wallets = await query(`
    SELECT 
        w.id,
        w.balance,
        w.created_at,
        w.updated_at,
        u.email,
        u.firebase_uid
    FROM wallets w
    JOIN users u ON w.user_id = u.id
    ORDER BY u.email
`);

console.log('📊 현재 wallets 상태:\n');
wallets.rows.forEach((row, index) => {
    console.log(`${index + 1}. ${row.email} (${row.firebase_uid})`);
    console.log(`   Balance: ${row.balance}`);
    console.log(`   Created: ${row.created_at}`);
    console.log(`   Updated: ${row.updated_at}\n`);
});

console.log(`총 ${wallets.rows.length}개 wallets`);

process.exit(0);

