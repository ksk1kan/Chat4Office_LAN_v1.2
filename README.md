# Chat4Office (LAN Web Uygulaması) v1.2

Bu sürümde (v1.1 üstüne):
- ✅ DM mesaj bildirimi (sekme arkasındayken/başka kişideyken “blip” sesi)
- ✅ DM + Grup: görsel/dosya gönderimi (LAN içi upload)
- ✅ Admin: kullanıcı rolünü sonradan değiştirebilme
- ✅ DM/Grup geçmişi “Temizle” (ekranda gizler, veritabanından silmez)
- ✅ Grup sohbet (oluşturan kişi + admin üye ekler/çıkarır)
- ✅ Kullanıcı avatarı (WhatsApp tarzı)

## Kurulum (Windows)
1) `npm install`
2) `npm start`
3) Sunucu PC: http://localhost:3000
4) Diğer PC: http://SUNUCU_IP:3000

SUNUCU_IP: `ipconfig` -> IPv4 Address

## İlk giriş
- kullanıcı: admin
- şifre: admin1234
Admin panel: /admin.html

## Sesler
- DM sesi: /sounds/dm.wav
- Hatırlatma sesi: /sounds/notify.wav
Admin panelden URL'leri değiştirebilirsin.

## Veri
- `data/db.json` ofis verisidir.
- Repo için örnek: `data/db.sample.json`
