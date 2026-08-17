# Docker — Build & Run

Do alag images hain:

| Image | Dockerfile | Kya hai |
|---|---|---|
| `sonarai-agent` | `Dockerfile` | Code / app — Node 22 + git + JRE 17 + sonar-scanner CLI |
| `sonarai-sonarqube` | `Dockerfile.sonarqube` | SonarQube 26.4.0.121862 |

Sirf **agent** ka port bahar khulta hai. SonarQube uske through milta hai:

- `http://localhost:3002` → dashboard
- `http://localhost:3002/sonarqube` → SonarQube UI

---

## Step 0 — Windows pe ek baar (warna SonarQube boot pe hi mar jayega)

SonarQube ka Elasticsearch ko `vm.max_map_count` chahiye. Docker Desktop (WSL2) ka
default kam padta hai:

```bash
wsl -d docker-desktop sysctl -w vm.max_map_count=524288
```

Agar ye skip kiya to SonarQube ka log ye dega aur container exit ho jayega:

```
max virtual memory areas vm.max_map_count [65530] is too low, increase to at least [262144]
```

Docker Desktop restart karne pe ye reset ho jata hai — dobara chala dena.

---

## Step 1 — Repo clone aur env file

```bash
git clone https://github.com/sachinnishad98/sonarqube-ai-agent-v1.git
cd sonarqube-ai-agent-v1

cp .env.docker.example .env.docker
```

Ab `.env.docker` kholo aur ye bharo:

```
GITHUB_TOKEN=<tumhara github pat>
ANTHROPIC_API_KEY=<tumhari claude key>
POSTGRES_PASSWORD=<koi bhi strong password>
ADMIN_PASSWORD=<agent ka admin password>
SONAR_TOKEN=                     # abhi khali chhod do — Step 5 me bharenge
```

> `ADMIN_PASSWORD` set zaroor karna. Nahi karoge to pehle boot pe random password
> generate hoke container log me sirf ek baar print hoga — miss hua to `data`
> volume delete karke dobara shuru karna padega.

> Apni purani Windows waali `.env` copy mat karna. Usme `REPO_PATH_...=D:\...`
> hai, aur Linux container me drive-letter path exist nahi karta.

---

## Step 2 — Dono images build karo

```bash
docker build -t sonarai-agent:2.1.0 .
docker build -f Dockerfile.sonarqube -t sonarai-sonarqube:26.4 .
```

Pehla build ~2-4 min lega (apt + npm ci + scanner download). Dusra jaldi ho jayega.

Check:

```bash
docker images | grep sonarai
```

---

## Step 3 — Network aur database

Teeno container ek hi network pe hone chahiye, warna ek dusre ka naam resolve
nahi karenge.

```bash
docker network create sonarai

docker run -d --name sonarai-db --network sonarai \
  -e POSTGRES_USER=sonar \
  -e POSTGRES_PASSWORD=<wahi password jo .env.docker me daala> \
  -e POSTGRES_DB=sonar \
  -v sonarai_pg:/var/lib/postgresql/data \
  postgres:16-alpine
```

---

## Step 4 — SonarQube chalao

Container ka naam **`sonarqube`** hi rakhna. Agent isi DNS naam pe connect karta
hai (`SONAR_URL=http://sonarqube:9000/sonarqube`).

```bash
docker run -d --name sonarqube --network sonarai \
  -e SONAR_JDBC_URL=jdbc:postgresql://sonarai-db:5432/sonar \
  -e SONAR_JDBC_USERNAME=sonar \
  -e SONAR_JDBC_PASSWORD=<wahi password> \
  -v sonarai_sonar_data:/opt/sonarqube/data \
  -v sonarai_sonar_ext:/opt/sonarqube/extensions \
  sonarai-sonarqube:26.4
```

Boot me 2-3 min lagte hain. Wait karo:

```bash
docker logs -f sonarqube
```

`SonarQube is operational` dikhe tab aage badho. Ya status check:

```bash
docker exec sonarqube curl -s http://localhost:9000/sonarqube/api/system/status
```

`{"status":"UP"}` aana chahiye.

> Yahan `-p` nahi diya hai — jaan-boojh kar. SonarQube bahar se seedha nahi
> khulta, sirf agent ke through.

---

## Step 5 — SONAR_TOKEN banao

SonarQube ka default login `admin` / `admin` hai, pehli baar password change
karayega. Token generate karo:

```bash
docker exec sonarqube curl -s -u admin:<naya password> \
  -X POST "http://localhost:9000/sonarqube/api/user_tokens/generate?name=agent"
```

Response me jo `"token":"sqa_..."` aayega, use `.env.docker` ke `SONAR_TOKEN=`
me daal do.

---

## Step 6 — Agent (code) image chalao

```bash
docker run -d --name sonarai-agent --network sonarai \
  -p 3002:3002 \
  --env-file .env.docker \
  -v sonarai_agent_data:/app/data \
  -v sonarai_agent_repos:/repos \
  sonarai-agent:2.1.0
```

Log dekho:

```bash
docker logs -f sonarai-agent
```

`Bind : 0.0.0.0:3002` dikhna chahiye. Agar `127.0.0.1` dikhe to `HOST` env
override ho gaya hai — port bahar se nahi khulega.

Ab kholo: **http://localhost:3002**

---

## Sab ek saath (chhota rasta)

Upar wale saare steps compose me already likhe hain:

```bash
docker compose up -d --build
docker compose logs -f agent
```

Band karne ke liye:

```bash
docker compose down          # data rehta hai
docker compose down -v       # volumes bhi delete (sab kuch mit jayega)
```

---

## Code change karne ke baad

Sirf agent image dobara build karni hai, SonarQube ko haath lagane ki zaroorat
nahi:

```bash
docker build -t sonarai-agent:2.1.0 .
docker rm -f sonarai-agent
docker run -d --name sonarai-agent --network sonarai -p 3002:3002 \
  --env-file .env.docker \
  -v sonarai_agent_data:/app/data -v sonarai_agent_repos:/repos \
  sonarai-agent:2.1.0
```

`sonarai_agent_data` volume rehne dena — usme admin account aur session secret
hai. Delete karoge to login password reset ho jayega.

---

## Kuch galat ho to

| Dikkat | Wajah / fix |
|---|---|
| SonarQube container turant exit | `vm.max_map_count` — Step 0 dobara chalao |
| `/sonarqube` khulta hai par CSS/JS toota hua | SonarQube `SONAR_WEB_CONTEXT=/sonarqube` ke bina chal raha hai |
| Agent me "SonarQube is not running" | Dono ek network pe nahi, ya container ka naam `sonarqube` nahi hai |
| `localhost:3002` connect nahi hota | `HOST=0.0.0.0` set nahi hai |
| Scan pe "sonar-scanner CLI not found" | Agent image purani hai — dobara build karo |
| Login password pata nahi | `docker logs sonarai-agent \| head -30`, ya `docker volume rm sonarai_agent_data` karke `ADMIN_PASSWORD` set karke restart |

Logs:

```bash
docker logs sonarai-agent
docker logs sonarqube
docker exec sonarqube tail -50 /opt/sonarqube/logs/es.log
```
