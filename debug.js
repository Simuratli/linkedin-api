/**
 * Bu dosya API sorununuzu teşhis etmek için debug komutlarını içerir
 */
const path = require('path');
const fs = require('fs').promises;
const { loadJobs, loadUserSessions } = require('./helpers/db');
const { synchronizeJobWithDailyStats } = require('./helpers/syncJobStats');

// Path to daily stats file
const DATA_DIR = path.join(process.cwd(), 'data');
const DAILY_STATS_FILE = path.join(DATA_DIR, 'daily_rate_limits.json');

/**
 * Debug testi çalıştır
 */
async function runDebugTests() {
  console.log('🔍 Debug testi başlatılıyor...');
  
  // 1. İş ve oturum verilerini yükle
  console.log('📊 İş ve oturum verilerini kontrol ediyorum...');
  try {
    const jobs = await loadJobs();
    const sessions = await loadUserSessions();
    
    console.log(`✅ Toplam iş sayısı: ${Object.keys(jobs).length}`);
    console.log(`✅ Toplam oturum sayısı: ${Object.keys(sessions).length}`);
    
    // İşleri ve durumlarını listele
    console.log('\n🔍 İşlerin durumu:');
    for (const [jobId, job] of Object.entries(jobs)) {
      console.log(`${jobId}: ${job.status} - ${job.processedCount}/${job.totalContacts} işlendi (${job.successCount} başarılı, ${job.failureCount} başarısız)`);
      console.log(`   Kullanıcı: ${job.userId}`);
      console.log(`   Oluşturma: ${job.createdAt}`);
      console.log(`   Son işlem: ${job.lastProcessedAt}`);
      
      if (job.pauseReason) {
        console.log(`   Duraklatma nedeni: ${job.pauseReason}`);
      }
      
      // İş işlemde ise bunu kontrol et
      if (job.status === 'processing') {
        console.log(`   ⚠️ Bu iş işlemde görünüyor ama muhtemelen çalışmıyor.`);
        
        // Kalan bekleyen kişileri say
        const pendingContacts = job.contacts.filter(c => c.status === 'pending').length;
        console.log(`   📊 Bekleyen kişi sayısı: ${pendingContacts}`);
        
        // İşlenmiş kişilerin durumlarını kontrol et
        const completedContacts = job.contacts.filter(c => c.status === 'completed').length;
        const failedContacts = job.contacts.filter(c => c.status === 'failed').length;
        const processingContacts = job.contacts.filter(c => c.status === 'processing').length;
        
        console.log(`   📊 Tamamlanan: ${completedContacts}, Başarısız: ${failedContacts}, İşlemde: ${processingContacts}`);
      }
    }
    
    // Kullanıcı oturumlarını kontrol et
    console.log('\n🔍 Kullanıcı oturumları:');
    for (const [userId, session] of Object.entries(sessions)) {
      console.log(`${userId}: Şu anki iş: ${session.currentJobId || 'Yok'}`);
      console.log(`   LinkedIn oturumu var mı: ${!!session.li_at && !!session.jsessionid}`);
      console.log(`   Dataverse oturumu var mı: ${!!session.accessToken}`);
      console.log(`   Son aktivite: ${session.lastActivity}`);
      
      // Bu kullanıcının aktif bir işi varsa, kontrol et
      if (session.currentJobId && jobs[session.currentJobId]) {
        const job = jobs[session.currentJobId];
        
        if (job.status === 'processing' && job.processedCount < job.totalContacts) {
          console.log(`   ⚠️ Bu kullanıcının devam eden bir işi var (${job.processedCount}/${job.totalContacts}) ama muhtemelen çalışmıyor.`);
        }
      }
    }
    
    // 2. Günlük istatistikleri kontrol et
    console.log('\n🔍 Günlük istatistikleri kontrol ediyorum...');
    try {
      const dailyStatsExists = await fs.access(DAILY_STATS_FILE).then(() => true).catch(() => false);
      
      if (!dailyStatsExists) {
        console.log(`⚠️ Günlük istatistik dosyası bulunamadı: ${DAILY_STATS_FILE}`);
        console.log(`   Muhtemelen bu sorunun nedeni budur.`);
      } else {
        const statsContent = await fs.readFile(DAILY_STATS_FILE, 'utf8');
        const stats = JSON.parse(statsContent);
        
        console.log(`✅ Günlük istatistikler yüklendi: ${Object.keys(stats).length} kullanıcı`);
        
        // Her kullanıcı için istatistikleri kontrol et
        for (const [userId, userStats] of Object.entries(stats)) {
          console.log(`   ${userId}: ${Object.keys(userStats).length} istatistik girişi`);
          
          // İşlemlerdeki günlük istatistikler ile karşılaştır
          for (const [jobId, job] of Object.entries(jobs)) {
            if (job.userId === userId) {
              console.log(`   İş ${jobId} ile karşılaştırılıyor: ${job.processedCount}/${job.totalContacts}`);
              
              // Bugünkü işlemleri karşılaştır
              const today = new Date().toISOString().split('T')[0];
              const todayStats = userStats[today] || 0;
              
              console.log(`   📊 Günlük istatistiklerdeki bugün işlenen: ${todayStats}`);
              console.log(`   📊 İş verisindeki işlenen: ${job.successCount || 0}`);
              
              if (todayStats !== (job.successCount || 0)) {
                console.log(`   ⚠️ Tutarsızlık tespit edildi! Günlük istatistikler ile iş verisi eşleşmiyor.`);
              }
            }
          }
        }
      }
    } catch (error) {
      console.error(`❌ Günlük istatistikleri kontrol ederken hata: ${error.message}`);
    }
    
    // 3. Senkronizasyon testini çalıştır
    console.log('\n🔄 Senkronizasyon fonksiyonu testi yapılıyor...');
    for (const [userId, session] of Object.entries(sessions)) {
      if (session.currentJobId && jobs[session.currentJobId]) {
        const job = jobs[session.currentJobId];
        
        try {
          console.log(`   🔄 ${userId} için iş senkronizasyonu başlatılıyor...`);
          await synchronizeJobWithDailyStats(userId, job);
          console.log(`   ✅ Senkronizasyon başarılı`);
        } catch (error) {
          console.error(`   ❌ Senkronizasyon hatası: ${error.message}`);
        }
      }
    }
    
    console.log('\n✅ Debug testi tamamlandı.');
    
  } catch (error) {
    console.error(`❌ Debug testi hatası: ${error.message}`);
  }
}

// Debug testini çalıştır
runDebugTests().then(() => {
  console.log('🏁 İşlem tamamlandı');
}).catch(error => {
  console.error(`❌ Ana hata: ${error.message}`);
});
