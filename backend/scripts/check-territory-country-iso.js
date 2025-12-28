/**
 * Territory countryIso 확인 스크립트
 * 
 * 사용법:
 *   node backend/scripts/check-territory-country-iso.js [territoryId]
 */

import dotenv from 'dotenv';
import { query, initDatabase } from '../db/init.js';

dotenv.config();

async function checkTerritory(territoryId) {
    try {
        await initDatabase();
        
        const result = await query(
            `SELECT id, country, country_iso, name, name_en 
             FROM territories 
             WHERE id = $1`,
            [territoryId]
        );
        
        if (result.rows.length === 0) {
            console.log(`❌ Territory not found: ${territoryId}`);
            process.exit(1);
        }
        
        const territory = result.rows[0];
        console.log(`\n📋 Territory: ${territoryId}`);
        console.log(`   id: ${territory.id}`);
        console.log(`   country: ${territory.country || 'null'}`);
        console.log(`   country_iso: ${territory.country_iso || 'null'}`);
        console.log(`   name: ${territory.name || 'null'}`);
        console.log(`   name_en: ${territory.name_en || 'null'}`);
        
        if (territory.country_iso) {
            console.log(`\n✅ country_iso is set: ${territory.country_iso}`);
        } else {
            console.log(`\n❌ country_iso is NULL - needs to be set!`);
            console.log(`   Run: node scripts/migrate-territory-country-iso.js`);
        }
        
        process.exit(0);
    } catch (error) {
        console.error('❌ Error:', error);
        process.exit(1);
    }
}

const territoryId = process.argv[2] || 'tamanghasset';
checkTerritory(territoryId);

