# Makefile — FastConnect Internet
# Usage: make <target>

.PHONY: help setup dev build start stop restart logs migrate seed test lint \
        ssl backup restore clean generate-keys

COMPOSE := docker compose
BACKEND  := $(COMPOSE) exec backend
DB_EXEC  := $(COMPOSE) exec mysql mysql -u$$DB_USER -p$$DB_PASSWORD fastconnect_db

##@ Setup & Configuration

help: ## Show this help message
	@awk 'BEGIN {FS = ":.*##"; printf "\nUsage:\n  make \033[36m<target>\033[0m\n"} /^[a-zA-Z_-]+:.*?##/ { printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2 } /^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5) } ' $(MAKEFILE_LIST)

setup: ## First-time setup: copy env, generate keys, build
	@echo "🔧 Setting up FastConnect..."
	@[ -f .env ] || cp .env.example .env && echo "  ✅ Created .env — EDIT IT before continuing!"
	@make generate-keys
	@echo "\n⚠️  Edit .env with your M-Pesa keys, then run: make build && make start && make seed"

generate-keys: ## Generate RSA keys and encryption keys
	@echo "🔑 Generating cryptographic keys..."
	@mkdir -p secrets
	@openssl genrsa -out secrets/jwt_private.pem 2048 2>/dev/null
	@openssl rsa -in secrets/jwt_private.pem -pubout -out secrets/jwt_public.pem 2>/dev/null
	@echo "  ✅ RSA key pair generated in secrets/"
	@echo "  📋 JWT_PRIVATE_KEY value:"
	@awk 'NF {sub(/\r/, ""); printf "%s\\n", $$0;}' secrets/jwt_private.pem
	@echo "\n  📋 JWT_PUBLIC_KEY value:"
	@awk 'NF {sub(/\r/, ""); printf "%s\\n", $$0;}' secrets/jwt_public.pem
	@echo "\n  📋 ENCRYPTION_KEY (copy to .env):"
	@node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
	@echo "\n  📋 BACKUP_ENCRYPTION_KEY:"
	@node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

##@ Development

dev: ## Start all services in development mode with hot reload
	@echo "🚀 Starting FastConnect in development mode..."
	$(COMPOSE) -f docker-compose.yml -f docker-compose.dev.yml up

dev-backend: ## Start only backend in dev mode
	cd backend && npm run dev

dev-frontend: ## Start only frontend in dev mode
	cd frontend && npm start

##@ Docker Operations

build: ## Build all Docker images
	@echo "🔨 Building Docker images..."
	$(COMPOSE) build --no-cache
	@echo "✅ Build complete"

start: ## Start all services
	@echo "▶  Starting FastConnect services..."
	$(COMPOSE) up -d
	@echo "✅ Services started"
	@make status

stop: ## Stop all services
	@echo "⏹  Stopping services..."
	$(COMPOSE) down
	@echo "✅ Stopped"

restart: ## Restart all services
	$(COMPOSE) restart

restart-backend: ## Restart only the backend API
	$(COMPOSE) restart backend

status: ## Show service status and health
	@echo "\n📊 Service Status:"
	$(COMPOSE) ps
	@echo "\n🔗 URLs:"
	@echo "  Portal:    https://wifi.fastconnect.co.ke"
	@echo "  Admin:     https://admin.fastconnect.co.ke"
	@echo "  API Docs:  https://wifi.fastconnect.co.ke/api-docs"

logs: ## Tail all service logs
	$(COMPOSE) logs -f

logs-backend: ## Tail backend API logs only
	$(COMPOSE) logs -f backend

logs-nginx: ## Tail nginx access + error logs
	$(COMPOSE) logs -f nginx

##@ Database

migrate: ## Run database migrations
	@echo "🗄  Running migrations..."
	$(BACKEND) node scripts/migrate.js
	@echo "✅ Migrations complete"

seed: ## Seed initial data (admin user, plans, demo voucher)
	@echo "🌱 Seeding database..."
	$(BACKEND) node scripts/seed.js
	@echo "✅ Seeding complete"

seed-reset: ## WARNING: Reset all data and re-seed
	@echo "⚠️  This will DELETE all data. Are you sure? [y/N]" && read ans && [ $${ans:-N} = y ]
	$(BACKEND) node scripts/seed.js --reset

db-shell: ## Open MySQL interactive shell
	$(COMPOSE) exec mysql mysql -u$$DB_USER -p$$DB_PASSWORD fastconnect_db

db-backup: ## Manually trigger database backup
	@echo "💾 Creating database backup..."
	$(BACKEND) node -e "require('./scripts/backup').run()"
	@echo "✅ Backup created in /tmp/backups/"

##@ SSL Certificates

ssl: ## Obtain Let's Encrypt SSL certificates
	@echo "🔒 Obtaining SSL certificates..."
	@echo "Make sure DNS is pointing to this server first!"
	$(COMPOSE) run --rm certbot certonly \
		--webroot --webroot-path=/var/www/certbot \
		--email admin@fastconnect.co.ke \
		--agree-tos --no-eff-email \
		-d wifi.fastconnect.co.ke \
		-d admin.fastconnect.co.ke
	@echo "✅ Certificates obtained"
	$(COMPOSE) restart nginx

ssl-renew: ## Manually renew SSL certificates
	$(COMPOSE) run --rm certbot renew

##@ Testing & Quality

test: ## Run backend test suite
	@echo "🧪 Running tests..."
	cd backend && npm test
	@echo "✅ Tests complete"

test-watch: ## Run tests in watch mode
	cd backend && npm test -- --watch

test-coverage: ## Run tests with coverage report
	cd backend && npm test -- --coverage

lint: ## Run ESLint on backend code
	cd backend && npm run lint

##@ Production Deployment

deploy: ## Full production deployment
	@echo "🚀 Deploying FastConnect to production..."
	git pull origin main
	make build
	$(COMPOSE) up -d --no-deps --build backend
	$(BACKEND) node scripts/migrate.js
	$(COMPOSE) restart nginx
	@echo "✅ Deployment complete"
	make status

health-check: ## Check all service health endpoints
	@echo "🏥 Health checks:"
	@curl -sf http://localhost:3000/health && echo "  ✅ Backend API: OK" || echo "  ❌ Backend API: FAILED"
	@curl -sf http://localhost:80/ > /dev/null && echo "  ✅ Frontend: OK" || echo "  ❌ Frontend: FAILED"
	@$(COMPOSE) exec redis redis-cli ping | grep -q PONG && echo "  ✅ Redis: OK" || echo "  ❌ Redis: FAILED"
	@$(COMPOSE) exec mysql mysqladmin ping -h localhost -u$$DB_USER -p$$DB_PASSWORD 2>/dev/null | grep -q alive && echo "  ✅ MySQL: OK" || echo "  ❌ MySQL: FAILED"

##@ Utilities

clean: ## Remove containers, volumes, and images (WARNING: destroys data)
	@echo "⚠️  This will destroy all data! Are you sure? [y/N]" && read ans && [ $${ans:-N} = y ]
	$(COMPOSE) down -v --rmi all --remove-orphans
	@echo "✅ Cleaned up"

ps: ## Show running containers
	$(COMPOSE) ps

exec-backend: ## Open shell in backend container
	$(COMPOSE) exec backend sh

exec-mysql: ## Open MySQL shell as root
	$(COMPOSE) exec mysql mysql -uroot -p$$DB_ROOT_PASSWORD fastconnect_db

active-users: ## Show currently connected users
	@echo "👥 Active WiFi users:"
	@curl -sf -H "Authorization: Bearer $$ADMIN_TOKEN" http://localhost:3000/api/admin/sessions/active | \
		node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');const r=JSON.parse(d);console.table(r.sessions)"

vouchers: ## Generate 10 demo vouchers for 24h plan
	@curl -sf -X POST http://localhost:3000/api/admin/vouchers/generate \
		-H "Authorization: Bearer $$ADMIN_TOKEN" \
		-H "Content-Type: application/json" \
		-d '{"planId":4,"quantity":10,"validityDays":30}' | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');const r=JSON.parse(d);r.codes.forEach(c=>console.log(c))"
