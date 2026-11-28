# XENORIZE MD – Vercel (pairing website + admin panel)

Website `/` (mini.html) aur admin `/admin` (admin.html) bot ke andar wale hi hain. `api/[...path].js` woh central API hai jo 5 servers ko jorti hai.

## Setup (Vercel)
1. Is folder ko PRIVATE GitHub repo mein daalein (keys code ke andar hain).
2. Vercel par import karein, Framework: "Other".
3. Deploy. Environment Variables ki zaroorat nahi.
4. Admin panel > Servers > har bot server add karein: id `server1`..`server5` (bot ki config.js ke `SERVER_ID` jaisa) aur url `http://IP:PORT`.
5. Har bot ki `config.js` mein `CENTRAL_URL` = aap ka Vercel link (bina `/` ke), phir bot restart.

## Kaam kaise karta hai
- User website par number likhta hai -> `/api/code` sab servers ko ping karta hai, jis mein jagah ho aur kam load ho us se code leta hai. Purana number wapas apne server par jata hai.
- Bots connect/disconnect par `/api/paired` ko batate hain (referral aur panel ki list isi se chalti hai).
- Admin panel ke fleet kaam (follow, chreact, arc, pollvote, runtime settings, plugin update) har server par bheje jate hain.
- Premium, referrals aur fleet passcode MongoDB mein hain.

## Zaroori
- Bot servers ka URL internet se khula hona chahiye (http://IP:PORT). Vercel https se http par call kar sakta hai, lekin ADMIN_KEY http par bina encryption ke jata hai: ho sake to har server par domain + https lagayein.
- Vercel function ka time limit: 60 sec. Bohat lambe kaam (pollvote/follow bohat sessions par) us se pehle server par queue ho jate hain.
