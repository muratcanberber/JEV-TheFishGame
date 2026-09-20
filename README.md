# 🐟 Jev Balık Oyunu

**Kararları yapay zekâ veren, gerçek zamanlı çok oyunculu bir balık oyunu.** Haritadaki balıkların her hamlesini — kaçmak, avlanmak, dolaşmak, hedef seçmek — TypeSafe'in **Jev** (System One) karar modeli belirler. Sen fareyle kendi balığını yönetirsin; griler ise milisaniyeler içinde "düşünür".

> Jev metin üretmez: verilen duruma karşı tiplendirilmiş kararlar döndürür (choice / noul / score). Bu oyun, "kod akışın sahibi, model yargı katmanı" deseninin canlı bir örneğidir.

## Özellikler

- 🧠 **Jev ile yapay zekâ** — Her AI balığı ~4-8 saniyede bir TypeSafe API'sine 3 soru sorar:
  - *Bir sonraki hamlen ne olmalı?* → `choice`: KAÇ / AVLA / YEM / DOLAN (olasılık dağılımıyla)
  - *Odaklanacağın hedef hangisi?* → `choice`: çevredeki yem/av/tehdit id'lerinden biri
  - *Hızını artıracak kadar tehdit var mı?* → `noul`: 0-1 panik olasılığı (sprint tetikler)
- 🎨 **Balığa tıkla, Jev'i dinle** — Herhangi bir balığa tıklayınca soru-cevap paneli açılır: ne görüyor, hangi sorular soruldu, hangi cevaplar yüzde/güvenle döndü.
- 🌐 **Gerçek zamanlı WebSocket** — Otoriter sunucu simülasyonu 30 Hz koşar, dünyayı 10 Hz WebSocket ile yayınlar; istemci ölü-hesap enterpolasyonuyla 60 fps akıcı çizer.
- 👥 **5 oyuncu + sınırsız izleyici** — Lakabınla katılır, kendi renkli balığını yönetirsin; kadro dolunca izleyici olursun. Host panelinden oyuncu düşürülebilir, izleyici atılabilir.
- 🌟 **Dikenler** — Agar.io patozları: çarpan balık patlar, parçaları yem olur. Jev de dikenleri görür ve kaçınır.
- 🐡 **Kütleyle azalan hız** — Küçük çevik, büyük hantaldır. Sabit taban hız, kütleyle yumuşak düşüş.
- 🔄 **Otomatik güncelleme** — Sunucu dosyaları değişince (deploy) bağlı istemciler versiyonu fark eder, depolamayı temizler ve kendini yeniler.
- 🛡️ **Güvenli mimari** — API anahtarı yalnızca sunucuda (`.env`), tarayıcıya asla gitmez. Jev'e ulaşılamazsa yerel yedek karar motoru devreye girer.

## Kurulum

```bash
git clone https://github.com/muratcanberber/jev-balik-oyunu.git
cd jev-balik-oyunu
npm install

# 1) TypeSafe anahtarını .env'e koy (repo buna benzer .env.example içerir)
cp .env.example .env
# .env dosyasını düzenle: TYPESAFE_API_KEY=console.typesafe.ai'den aldığın anahtar

# 2) Başlat
npm start
# → http://localhost:8787
```

> Anahtarın yoksa [console.typesafe.ai/settings/keys](https://console.typesafe.ai/settings/keys) adresinden alabilirsin. Anahtarsız da oyun çalışır — tüm AI balıkları yerel yedek motorla karar verir (HUD'da "yerel" yazar).

## Nasıl oynanır?

| Girdi | Aksiyon |
|---|---|
| Fare | Balığını yönlendir |
| Basılı tut | Hafif hızlan |
| Balığa tıkla | O balığın Jev soru-cevap panelini aç |
| Sol alt "👤 profil / rol" | Lakap değiştir, oyuncu ↔ izleyici geçiş yap |

- Yeşil noktalar **yem**: yedikçe büyürsün (büyük balık yemden az faydalanır).
- Senden **%30 küçük** balıkları yiyebilirsin; senden **%25 büyük**ler seni.
- Kırmızı **dikenlere** çarpma — patlarsın, parçaların yem olur!
- Yetişemeyeceğin kadar büyümüşsen... artık haritanın efendisisin. 😄

## Mimari

```
[Otoriter Node sunucusu]
  ├─ 30 Hz simülasyon (fizik, yeme, duvarlar, dikenler)
  ├─ Jev karar döngüsü: balık başına ~4-8 sn'de bir, eşzamanlı 3 istek
  ├─ WebSocket /ws → 10 Hz dünya karesi + karar olayları
  └─ localhost'a özel host API'si (/yonetim, /reset)

[Tarayıcı istemcisi]
  ├─ Three.js r160 (orthographic 2D sahne)
  ├─ Ölü-hesap enterpolasyon: 10 Hz veri → 60 fps akıcı çizim
  ├─ Soru-cevap inceleme paneli (JSON değil, okunabilir)
  └─ Versiyon uyuşmazlığında otomatik yenilenme
```

### Jev isteği örneği

```json
{
  "state": {
    "ben": { "kimlik": "Gölge", "boyut_kg": 1.48 },
    "cevre": {
      "yemler": [{ "id": "y3", "mesafe": 140, "yone": "sağ yukarı" }],
      "kucuk_baliklar": [],
      "buyuk_baliklar": [{ "id": "SEN", "boyut_orani": 1.9, "mesafe": 170 }],
      "tehdit_yakinligi_pct": 0.73,
      "duvar": { "sol": 900, "sag": 1000, "ust": 700, "alt": 450 }
    }
  },
  "questions": {
    "eylem": { "type": "choice", "...": "kac/avla/yem_ye/dolan" },
    "hedef": { "type": "choice", "...": "çevredeki nesne id'leri" },
    "panik": { "type": "noul", "instructions": "hız artıracak kadar tehdit var mı?" }
  }
}
```

Karar eşikleri, duvar ve diken kaçınma politikaları **koddadır**; Jev yalnızca yargıyı üretir.

## Dağıtım (izleyicilere açmak için)

Hızlı yol — Cloudflare Quick Tunnel (hesap gerekmez):

```bash
npm start &                                  # sunucu
cloudflared tunnel --url http://localhost:8787
# → çıktıdaki https://*.trycloudflare.com adresini paylaş
```

Not: Quick Tunnel her açılışta farklı adres üretir. Kalıcı adres için Cloudflare named tunnel kullanın. Sunucu güncellenince bağlı istemciler otomatik yenilenir.

## Performans

5 AI balıkta karar trafiği ~70 istek/dk (TypeSafe limiti: 1.200/dk), saatlik maliyet ~$0,10. Dünya karesi ~1,5 KB × 10 Hz; onlarca izleyici rahat taşınır.

## Lisans

MIT
