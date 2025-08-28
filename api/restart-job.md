# /debug-restart-job/:jobId API

Bu endpoint ile bir job'ın status'u failed/cancelled ise frontend'den bir buton ile tekrar başlatabilirsin.

- POST /debug-restart-job/:jobId
- Job status'u otomatik olarak "processing" yapılır ve arka planda tekrar başlatılır.
- Gerekirse user session eksikse placeholder ile oluşturulur.
- Pause reason, error gibi alanlar temizlenir.

## Örnek frontend buton fonksiyonu

```js
async function restartJob(jobId) {
  const res = await fetch(`/debug-restart-job/${jobId}`, { method: 'POST' });
  const data = await res.json();
  if (data.success) {
    alert('Job yeniden başlatıldı!');
    // İsterseniz sayfayı yenileyin veya job progresini güncelleyin
  } else {
    alert('Başlatılamadı: ' + data.message);
  }
}
```

## Kullanım
- Job status "failed" veya "cancelled" ise, frontend'de bir "Yeniden Başlat" butonu göster.
- Butona basınca yukarıdaki fonksiyonu çağır.
- Backend otomatik olarak job'ı tekrar başlatır.
