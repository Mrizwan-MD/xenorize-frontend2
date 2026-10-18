# Secure deployment values

Do not put GitHub tokens or MongoDB passwords inside this ZIP or commit them to GitHub.

Set these variables in Vercel Project Settings → Environment Variables:

```env
ADMIN_KEY=mrizwan
WORKER_ADMIN_KEY=mrizwan
WORKER_URL_1=http://93.115.106.210:6656
VPS_URL=http://93.115.106.210:6656
BASE_URL=http://93.115.106.210:6656
REF_TARGET=10
REF_PREMIUM_DAYS=7
```

Set these variables in Railway for the bot worker:

```env
ADMIN_KEY=mrizwan
MONGODB_URI=<your rotated MongoDB connection string>
```

`mrizwan` is a weak temporary admin key requested for this setup. Change it to a long random value before making the admin page public.

The GitHub token and MongoDB URI previously pasted into chat are exposed credentials. Revoke the GitHub token immediately and rotate the MongoDB database user password before deployment. Never put either secret in `README.md`, HTML, JavaScript, ZIP files, or GitHub source code.
