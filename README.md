Bu sürümde:
- ✅ DM okundu bilgisi + okunmayan sayaç
- ✅ Not/hatırlatma okundu bilgisi
- ✅ "Bitir" yapan kişi kapatır + kim bitirdiği loglanır
- ✅ Not silme: sadece oluşturan kişi + admin
- ✅ “data/db.json repo’ya konmaz. İlk kurulumda db.sample.json’u kopyalayıp db.json yapın.”

## Kurulum (Windows)
PowerShell'de `npm` engeli alırsan en kolayı **CMD** kullanmak.

1) `npm install`
2) `npm start`
3) Sunucu PC: http://localhost:3000
4) Diğer PC: http://SUNUCU_IP:3000

SUNUCU_IP: `ipconfig` -> IPv4 Address

## İlk giriş
- kullanıcı: admin
- şifre: admin1234
Admin panel: /admin.html

## Ses
En stabil yöntem:
- `public/notify.wav` dosyasını değiştir
- Admin panelde Ses URL: `/notify.wav`

------------------------------------------------------
# Chat4Office (LAN Web App) v1.1

What’s included in this version:
- ✅ DM read receipts + unread counter
- ✅ Notes/Reminders read tracking
- ✅ “Done” can be closed by the person who completes it + completion is logged (who/when)
- ✅ Delete permission: only the creator + admin
- ✅ `data/db.json` is NOT committed to the repository. On first setup, copy `db.sample.json` to `db.json`.

## Installation (Windows)
If PowerShell blocks `npm`, the easiest option is to use **CMD**.

1) `npm install`  
2) `npm start`  
3) Server PC: http://localhost:3000  
4) Other PCs: http://SERVER_IP:3000  

SERVER_IP: run `ipconfig` and use the **IPv4 Address**.

## First Login
- Username: `admin`
- Password: `admin1234`  
Admin panel: `/admin.html`

## Notification Sound
Most stable approach:
- Replace the file: `public/notify.wav`
- In the Admin panel set Sound URL to: `/notify.wav`
