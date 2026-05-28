# PlakshaBudget - Full Stack Setup & Deployment Guide

PlakshaBudget is a modern, responsive department budget and expense tracking application built with React (frontend), Node.js/Express (backend), and PostgreSQL/MySQL (database).

---

## 📋 Prerequisites
Before setting up the project on your production or staging server, ensure the following are installed:
- **Node.js** (v18.0.0 or higher)
- **NPM** (v9.0.0 or higher)
- **MySQL Server** (v8.0 or higher)
- **Nginx** (Web server & reverse proxy)
- **PM2** (Node process manager: `npm install -g pm2`)

---

## 🛠️ Step 1: Code Deployment
Clone or upload the repository files to your desired deployment directory on the server (e.g., `/var/www/plakshabudget`):

```bash
mkdir -p /var/www/plakshabudget
cd /var/www/plakshabudget
# [Extract / Git clone code here]
```

Install all required production and development dependencies:
```bash
npm install
```

---

## 🗄️ Step 2: MySQL Database Setup

1. **Log in to your MySQL terminal** (or use PHPMyAdmin/other database client):
   ```sql
   mysql -u root -p
   ```

2. **Create the database**:
   ```sql
   CREATE DATABASE IF NOT EXISTS plakshabudget CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   ```

3. **Configure Environment Variables**:
   Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```
   Open the `.env` file and configure your database parameters:
   ```env
   DB_TYPE=mysql
   DB_HOST=localhost
   DB_PORT=3306
   DB_NAME=plakshabudget
   DB_USER=your_mysql_user
   DB_PASS="your_mysql_password"
   ```

4. **Initialize Schema & Seed Admin**:
   Run the automated database initialization script. This creates all necessary tables, constraints, indices, and seeds the default administrator account:
   ```bash
   npm run db:init
   ```

---

## ⚙️ Step 3: Environment Configuration (.env)
Edit your `.env` file to customize your app settings. Key parameters include:

```env
# Server
PORT=4000
JWT_SECRET=a_very_strong_random_secret_hash_key

# Website URLs
# Set the FRONTEND_URL to the website's public domain. The backend uses this for link redirects in emails.
FRONTEND_URL=http://plakshabudget.yourdomain.com
# Set the VITE_API_URL to the backend URL. The React client uses this to query the API.
VITE_API_URL=http://plakshabudget.yourdomain.com

# SMTP configuration for sequential email approvals
SMTP_HOST=smtp.office365.com
SMTP_PORT=587
SMTP_USER=webmaster@plaksha.edu.in
SMTP_PASS="your_smtp_pass"
SMTP_FROM=webmaster@plaksha.edu.in

# Microsoft SSO (Optional: leave client ID empty to run Simulated SSO Mode)
MICROSOFT_CLIENT_ID=your_azure_client_id
MICROSOFT_CLIENT_SECRET=your_azure_client_secret
MICROSOFT_REDIRECT_URI=http://plakshabudget.yourdomain.com/api/auth/microsoft/callback

# Microsoft Teams Webhook for Notifications (Optional)
TEAMS_WEBHOOK_URL=https://yourcompany.webhook.office.com/webhookb2/...
```

---

## 🏗️ Step 4: Build React Frontend
Compile the React application into static assets. The generated static output directory is `dist/`:

```bash
npm run build
```
This processes and minifies your scripts, styles, and binds the environment's `VITE_API_URL` directly into the client bundle.

---

## 🚀 Step 5: Start Backend API (using PM2)
Run the Node.js API backend continuously as a background process using the PM2 daemon:

```bash
# Start backend server
pm2 start server.js --name plakshabudget-api

# Configure PM2 to start automatically on system boot
pm2 startup
pm2 save
```

To view running processes and logs:
```bash
pm2 status
pm2 logs plakshabudget-api
```

---

## 🌐 Step 6: Configure Nginx Web Server
Nginx serves the frontend static directory (`dist/`) and reverse-proxies incoming API requests to the backend server running on port `4000`.

1. Create a new virtual host configuration file:
   ```bash
   sudo nano /etc/nginx/sites-available/plakshabudget
   ```

2. Add the following Nginx server block (replace `plakshabudget.yourdomain.com` and `/var/www/...` with your actual domain and paths):
   ```nginx
   server {
       listen 80;
       server_name plakshabudget.yourdomain.com;

       # Serve static React frontend
       root /var/www/plakshabudget/dist;
       index index.html;

       location / {
           try_files $uri $uri/ /index.html;
       }

       # Proxy API requests to Node backend (Port 4000)
       location /api/ {
           proxy_pass http://localhost:4000;
           proxy_http_version 1.1;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection 'upgrade';
           proxy_set_header Host $host;
           proxy_cache_bypass $http_upgrade;
           proxy_set_header X-Real-IP $remote_addr;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto $scheme;
           
           # Allow up to 50MB uploads for indent attachments
           client_max_body_size 50m;
       }

       # Error pages config
       error_log  /var/log/nginx/plakshabudget.error.log;
       access_log /var/log/nginx/plakshabudget.access.log;
   }
   ```

3. Enable the configuration and restart Nginx:
   ```bash
   sudo ln -s /etc/nginx/sites-available/plakshabudget /etc/nginx/sites-enabled/
   sudo nginx -t
   sudo systemctl restart nginx
   ```

---

## 🔑 Step 7: Initial Login Credentials
Once deployed, navigate to your server domain (e.g., `http://plakshabudget.yourdomain.com`) and log in:
- **User ID**: `admin`
- **Password**: `admin123`

> [!WARNING]
> Change the default administrator password immediately after logging in by visiting the **Profile** page.

---

## 🛠️ Step 8: Administrative Tasks & Utilities
- **Reset Admin Password**: In case you forget your admin password, reset it back to `admin123` by running:
  ```bash
  npm run admin:reset
  ```
- **Reset Database**: To completely reinitialize and seed clean database tables:
  ```bash
  npm run db:init
  ```

---

## 🔗 How to Get Microsoft Teams Webhook URL

Microsoft Teams provides incoming webhooks either via the legacy **Office 365 Connectors** or the modern **Workflows App** (Power Automate).

### Option A: Using the Workflows App (Recommended for New Channels)
Microsoft is transitioning incoming webhooks to the **Workflows** system. Follow these steps:
1. Inside Microsoft Teams, open the **Apps** store on the bottom left and search for **Workflows**.
2. Select the template named **"Post to a channel when a webhook request is received"**.
3. Choose a custom name for the workflow (e.g., `PlakshaBudget Webhook`).
4. Select the **Team** and the specific **Channel** where approval cards should be posted.
5. Click **Add workflow** (or **Next**).
6. Once configured, Power Automate will display a unique HTTP POST URL.
7. **Copy this URL** and paste it into `.env` as `TEAMS_WEBHOOK_URL`.

### Option B: Using Classic Incoming Webhooks (If Enabled)
If your organization still allows legacy Office 365 connectors:
1. In Microsoft Teams, navigate to the Team and Channel where you want notifications.
2. Click the `...` (More options) next to the channel name and select **Connectors** (or **Manage Channel** -> **Connectors**).
3. Search for **Incoming Webhook** and click **Configure**.
4. Type a name (e.g., `PlakshaBudget Notifications`), upload a logo, and click **Create**.
5. **Copy the webhook URL** generated at the bottom of the screen.
6. Paste the URL into `.env` as `TEAMS_WEBHOOK_URL`.

