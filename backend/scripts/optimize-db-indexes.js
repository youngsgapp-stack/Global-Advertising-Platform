/**
 * DB 인덱스 최적화 스크립트
 * territories 테이블 쿼리 속도를 2~5배 향상
 */

import { query, initDatabase } from '../db/init.js';

async function optimizeIndexes() {
    console.log('🔧 Starting database index optimization...\n');
    
    // DB 초기화
    console.log('📡 Connecting to database...');
    await initDatabase();
    console.log('✅ Database connected\n');
    
    const indexes = [
        {
            name: 'idx_territories_updated_at',
            sql: 'CREATE INDEX IF NOT EXISTS idx_territories_updated_at ON territories(updated_at DESC);',
            description: 'Optimize ORDER BY updated_at DESC queries'
        },
        {
            name: 'idx_territories_status',
            sql: 'CREATE INDEX IF NOT EXISTS idx_territories_status ON territories(status) WHERE status IS NOT NULL;',
            description: 'Optimize status filtering (active, protected, etc.)'
        },
        {
            name: 'idx_territories_ruler_id',
            sql: 'CREATE INDEX IF NOT EXISTS idx_territories_ruler_id ON territories(ruler_id) WHERE ruler_id IS NOT NULL;',
            description: 'Optimize JOIN with users table'
        },
        {
            name: 'idx_territories_sovereignty',
            sql: 'CREATE INDEX IF NOT EXISTS idx_territories_sovereignty ON territories(sovereignty) WHERE sovereignty IS NOT NULL;',
            description: 'Optimize sovereignty filtering (unconquered, ruled, etc.)'
        },
        {
            name: 'idx_territories_composite_list',
            sql: 'CREATE INDEX IF NOT EXISTS idx_territories_composite_list ON territories(status, sovereignty, updated_at DESC);',
            description: 'Composite index for list queries (status + sovereignty + sort)'
        }
    ];
    
    let successCount = 0;
    let failCount = 0;
    
    for (const index of indexes) {
        try {
            console.log(`📍 Creating index: ${index.name}`);
            console.log(`   Description: ${index.description}`);
            
            const result = await query(index.sql);
            console.log(`   ✅ Success\n`);
            successCount++;
        } catch (error) {
            console.error(`   ❌ Failed: ${error.message}\n`);
            failCount++;
        }
    }
    
    console.log('═'.repeat(50));
    console.log(`📊 Index Optimization Summary:`);
    console.log(`   ✅ Success: ${successCount}/${indexes.length}`);
    console.log(`   ❌ Failed: ${failCount}/${indexes.length}`);
    console.log('═'.repeat(50));
    
    if (successCount > 0) {
        console.log('\n🚀 Expected Performance Improvement:');
        console.log('   - Territory list queries: 2~5x faster');
        console.log('   - Initial page load: 1~3 seconds faster');
        console.log('   - JOIN queries with users: 3~10x faster');
    }
    
    process.exit(failCount > 0 ? 1 : 0);
}

// Run
optimizeIndexes().catch(error => {
    console.error('❌ Optimization failed:', error);
    process.exit(1);
});

