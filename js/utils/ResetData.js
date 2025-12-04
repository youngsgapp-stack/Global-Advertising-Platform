/**
 * 모든 픽셀 편집 데이터 및 관리자 모드 구매 지역 초기화 유틸리티
 * 브라우저 콘솔에서 바로 실행 가능
 */

import { CONFIG, log } from '../config.js';
import { firebaseService } from '../services/FirebaseService.js';

/**
 * 모든 픽셀 캔버스 데이터 초기화
 */
export async function resetAllPixelCanvases() {
    console.log('🔄 픽셀 캔버스 데이터 초기화 시작...');
    
    if (!firebaseService.initialized) {
        console.error('❌ Firebase가 초기화되지 않았습니다.');
        return;
    }
    
    try {
        const { collection, getDocs, deleteDoc } = firebaseService._firestore;
        const pixelCanvasesRef = collection(firebaseService.db, 'pixelCanvases');
        const snapshot = await getDocs(pixelCanvasesRef);
        
        let deletedCount = 0;
        const deletePromises = [];
        
        snapshot.forEach((docSnapshot) => {
            deletePromises.push(deleteDoc(docSnapshot.ref));
            deletedCount++;
        });
        
        await Promise.all(deletePromises);
        
        console.log(`✅ ${deletedCount}개의 픽셀 캔버스 데이터 삭제 완료`);
        return deletedCount;
    } catch (error) {
        console.error('❌ 픽셀 캔버스 데이터 초기화 실패:', error);
        throw error;
    }
}

/**
 * 모든 영토의 픽셀 캔버스 메타데이터 초기화
 */
export async function resetTerritoryPixelMetadata() {
    console.log('🔄 영토 픽셀 메타데이터 초기화 시작...');
    
    if (!firebaseService.initialized) {
        console.error('❌ Firebase가 초기화되지 않았습니다.');
        return;
    }
    
    try {
        const { collection, getDocs, doc, updateDoc, deleteField } = firebaseService._firestore;
        const territoriesRef = collection(firebaseService.db, 'territories');
        const snapshot = await getDocs(territoriesRef);
        
        let updatedCount = 0;
        const updatePromises = [];
        
        snapshot.forEach((docSnapshot) => {
            const territoryData = docSnapshot.data();
            
            // pixelCanvas 필드가 있으면 제거
            if (territoryData.pixelCanvas) {
                const territoryRef = doc(firebaseService.db, 'territories', docSnapshot.id);
                updatePromises.push(
                    updateDoc(territoryRef, {
                        pixelCanvas: deleteField(),
                        territoryValue: 0
                    })
                );
                updatedCount++;
            }
        });
        
        await Promise.all(updatePromises);
        
        console.log(`✅ ${updatedCount}개의 영토 픽셀 메타데이터 초기화 완료`);
        return updatedCount;
    } catch (error) {
        console.error('❌ 영토 픽셀 메타데이터 초기화 실패:', error);
        throw error;
    }
}

/**
 * 모든 관리자 모드 구매 지역 초기화
 */
export async function resetAdminPurchases() {
    console.log('🔄 관리자 모드 구매 지역 초기화 시작...');
    
    if (!firebaseService.initialized) {
        console.error('❌ Firebase가 초기화되지 않았습니다.');
        return;
    }
    
    try {
        const { collection, getDocs, doc, updateDoc } = firebaseService._firestore;
        const territoriesRef = collection(firebaseService.db, 'territories');
        const snapshot = await getDocs(territoriesRef);
        
        let resetCount = 0;
        const resetPromises = [];
        
        snapshot.forEach((docSnapshot) => {
            const territoryData = docSnapshot.data();
            const updates = {};
            
            // 정복된 영토 초기화
            if (territoryData.sovereignty === 'ruled' || territoryData.ruler) {
                updates.sovereignty = 'unconquered';
                updates.ruler = null;
                updates.rulerName = null;
                updates.rulerSince = null;
                updates.protectedUntil = null;
                updates.territoryValue = 0;
                resetCount++;
            }
            
            if (Object.keys(updates).length > 0) {
                const territoryRef = doc(firebaseService.db, 'territories', docSnapshot.id);
                resetPromises.push(updateDoc(territoryRef, updates));
            }
        });
        
        await Promise.all(resetPromises);
        
        console.log(`✅ ${resetCount}개의 관리자 모드 구매 지역 초기화 완료`);
        return resetCount;
    } catch (error) {
        console.error('❌ 관리자 모드 구매 지역 초기화 실패:', error);
        throw error;
    }
}

/**
 * 모든 데이터 초기화 (전체 리셋)
 */
export async function resetAllData() {
    if (!confirm('⚠️ 경고: 모든 픽셀 편집 데이터와 관리자 모드 구매 지역을 초기화합니다. 계속하시겠습니까?')) {
        console.log('초기화가 취소되었습니다.');
        return;
    }
    
    console.log('🚀 모든 데이터 초기화 시작...\n');
    
    try {
        // 1. 픽셀 캔버스 데이터 초기화
        const pixelCount = await resetAllPixelCanvases();
        console.log('');
        
        // 2. 영토 픽셀 메타데이터 초기화
        const metadataCount = await resetTerritoryPixelMetadata();
        console.log('');
        
        // 3. 관리자 모드 구매 지역 초기화
        const purchaseCount = await resetAdminPurchases();
        console.log('');
        
        console.log('✅ 모든 데이터 초기화 완료!');
        console.log(`📊 초기화 통계:`);
        console.log(`   - 픽셀 캔버스: ${pixelCount}개`);
        console.log(`   - 영토 메타데이터: ${metadataCount}개`);
        console.log(`   - 구매 지역: ${purchaseCount}개`);
        console.log('\n🔄 페이지를 새로고침하여 변경사항을 확인하세요.');
        
        // 페이지 새로고침 제안
        if (confirm('페이지를 새로고침하시겠습니까?')) {
            location.reload();
        }
        
    } catch (error) {
        console.error('❌ 초기화 중 오류 발생:', error);
        throw error;
    }
}

// 브라우저 콘솔에서 실행 가능하도록 전역 함수로 등록 (콘솔 메시지 없이)
if (typeof window !== 'undefined') {
    window.resetAllPixelData = resetAllPixelCanvases;
    window.resetAllTerritoryMetadata = resetTerritoryPixelMetadata;
    window.resetAllAdminPurchases = resetAdminPurchases;
    window.resetAllData = resetAllData;
    // 콘솔 메시지 제거됨
}

