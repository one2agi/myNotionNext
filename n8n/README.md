# n8n 自托管部署

## 前置条件

- VPS（需有公网 IP 或域名）
- Docker + Docker Compose 已安装
- Nginx（生产环境推荐）
- HTTPS 证书（Let's Encrypt 或已有证书）

## 快速启动

```bash
# 1. 编辑 .env，填入真实值
vim .env

# 2. 启动 n8n + Redis
docker compose up -d

# 3. 初始化 n8n
# 访问 http://your-vps-ip:5678
# 首次打开设置 admin 账号和密码

# 4. 导入 workflow
# Settings → Import from File → 选择 workflow-zpay-order.json

# 5. 激活 workflow
# 打开 workflow → 右上角 Toggle → Active
```

## HTTPS + 域名配置（Nginx）

```nginx
# /etc/nginx/conf.d/n8n.conf
server {
    listen 443 ssl;
    server_name n8n.yourdomain.com;

    ssl_certificate     /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    client_max_body_size 10m;

    # n8n UI
    location / {
        proxy_pass http://localhost:5678;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Webhook path (must be accessible without auth)
    location /webhook/ {
        proxy_pass http://localhost:5678;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }

    # Webhook test path
    location /webhook-test/ {
        proxy_pass http://localhost:5678;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 300s;
    }
}
```

```bash
# 验证 nginx 配置
nginx -t

# 重载 nginx
nginx -s reload
```

## 更新 n8n

```bash
docker compose pull
docker compose up -d
```

## 查看日志

```bash
docker compose logs -f n8n
```

## 环境变量说明

| 变量 | 必需 | 说明 |
|------|------|------|
| `N8N_HOST` | 是 | 你的 VPS 域名或 IP |
| `N8N_ENCRYPTION_KEY` | 是 | 加密密钥，随机生成，**不要改** |
| `SENTRY_DSN` | 否 | Sentry 上报，留空则禁用 |
| `EXECUTIONS_MODE` | 否 | `queue` 开启 Redis 队列模式 |

## 防火墙

确保以下端口可访问：

| 端口 | 来源 | 说明 |
|------|------|------|
| 5678 | 仅管理端 | 建议限 IP 访问，或仅内网访问 |
| 443 | 所有人 | HTTPS，webhook 接收 |
| 80 | 可选 | ACME 证书申请用 |