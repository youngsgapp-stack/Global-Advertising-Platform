/**
 * Price 표시 로직 순수 JavaScript 테스트 (DB 불필요)
 * 
 * TerritoryPanel.js의 로직을 시뮬레이션하여 테스트
 */

// 프론트엔드 로직 시뮬레이션 (TerritoryPanel.js와 동일)
function calculateDisplayPrice(territory, basePrice) {
    let realPrice;
    
    // 디버깅 로그
    if (territory.last_winning_amount !== undefined) {
        console.log(`  [Logic] territory.last_winning_amount found: ${territory.last_winning_amount} (type: ${typeof territory.last_winning_amount})`);
    } else {
        console.log(`  [Logic] territory.last_winning_amount is undefined`);
    }
    
    // 실제 로직
    if (territory.last_winning_amount && parseFloat(territory.last_winning_amount) > 0) {
        realPrice = parseFloat(territory.last_winning_amount);
        console.log(`  [Logic] ✅ Using last_winning_amount as price: ${realPrice} pt`);
        return { price: realPrice, source: 'last_winning_amount' };
    } else {
        realPrice = basePrice;
        console.log(`  [Logic] Using calculated base price: ${realPrice} pt (last_winning_amount: ${territory.last_winning_amount || 'null'})`);
        return { price: realPrice, source: 'calculated' };
    }
}

// 테스트 케이스
const testCases = [
    {
        name: '케이스 1: last_winning_amount = 450',
        territory: { id: 'test-1', last_winning_amount: 450, base_price: 100 },
        basePrice: 100,
        expected: { price: 450, source: 'last_winning_amount' }
    },
    {
        name: '케이스 2: last_winning_amount = "450" (문자열)',
        territory: { id: 'test-2', last_winning_amount: '450', base_price: 100 },
        basePrice: 100,
        expected: { price: 450, source: 'last_winning_amount' }
    },
    {
        name: '케이스 3: last_winning_amount = null',
        territory: { id: 'test-3', last_winning_amount: null, base_price: 100 },
        basePrice: 100,
        expected: { price: 100, source: 'calculated' }
    },
    {
        name: '케이스 4: last_winning_amount = undefined',
        territory: { id: 'test-4', base_price: 100 },
        basePrice: 100,
        expected: { price: 100, source: 'calculated' }
    },
    {
        name: '케이스 5: last_winning_amount = 0',
        territory: { id: 'test-5', last_winning_amount: 0, base_price: 100 },
        basePrice: 100,
        expected: { price: 100, source: 'calculated' }
    },
    {
        name: '케이스 6: last_winning_amount = "" (빈 문자열)',
        territory: { id: 'test-6', last_winning_amount: '', base_price: 100 },
        basePrice: 100,
        expected: { price: 100, source: 'calculated' }
    },
    {
        name: '케이스 7: last_winning_amount = "0" (문자열 0)',
        territory: { id: 'test-7', last_winning_amount: '0', base_price: 100 },
        basePrice: 100,
        expected: { price: 100, source: 'calculated' }
    },
    {
        name: '케이스 8: last_winning_amount = -100 (음수)',
        territory: { id: 'test-8', last_winning_amount: -100, base_price: 100 },
        basePrice: 100,
        expected: { price: 100, source: 'calculated' }
    },
    {
        name: '케이스 9: last_winning_amount = 999.99 (소수점)',
        territory: { id: 'test-9', last_winning_amount: 999.99, base_price: 100 },
        basePrice: 100,
        expected: { price: 999.99, source: 'last_winning_amount' }
    },
    {
        name: '케이스 10: last_winning_amount = "999.99" (문자열 소수점)',
        territory: { id: 'test-10', last_winning_amount: '999.99', base_price: 100 },
        basePrice: 100,
        expected: { price: 999.99, source: 'last_winning_amount' }
    }
];

console.log('🧪 Price 표시 로직 순수 JavaScript 테스트\n');
console.log('='.repeat(70));

let passed = 0;
let failed = 0;

testCases.forEach((testCase, index) => {
    console.log(`\n📋 ${testCase.name}`);
    console.log('-'.repeat(70));
    
    const result = calculateDisplayPrice(testCase.territory, testCase.basePrice);
    
    const priceMatch = Math.abs(result.price - testCase.expected.price) < 0.01; // 소수점 오차 허용
    const sourceMatch = result.source === testCase.expected.source;
    
    if (priceMatch && sourceMatch) {
        console.log(`  ✅ PASS: ${result.price} pt (${result.source})`);
        passed++;
    } else {
        console.log(`  ❌ FAIL:`);
        console.log(`     예상: ${testCase.expected.price} pt (${testCase.expected.source})`);
        console.log(`     실제: ${result.price} pt (${result.source})`);
        failed++;
    }
});

console.log('\n' + '='.repeat(70));
console.log('📊 테스트 결과 요약');
console.log('='.repeat(70));
console.log(`✅ 통과: ${passed}/${testCases.length}`);
console.log(`❌ 실패: ${failed}/${testCases.length}`);

if (failed === 0) {
    console.log('\n🎉 모든 테스트 통과!');
    process.exit(0);
} else {
    console.log('\n⚠️  일부 테스트 실패');
    process.exit(1);
}

