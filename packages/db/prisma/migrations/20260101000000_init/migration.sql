-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'USER');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "ApiKeyStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('GRANT', 'TOPUP', 'DEDUCT', 'ADJUST');

-- CreateEnum
CREATE TYPE "WireApi" AS ENUM ('CHAT', 'RESPONSES');

-- CreateEnum
CREATE TYPE "RoutingStrategy" AS ENUM ('PRIORITY', 'ROUND_ROBIN', 'WEIGHTED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "password_hash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "totp_secret" TEXT,
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "user_agent" TEXT,
    "ip" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Default key',
    "key_hash" TEXT NOT NULL,
    "key_encrypted" TEXT,
    "key_prefix" TEXT NOT NULL,
    "token_quota" BIGINT NOT NULL DEFAULT 0,
    "token_used" BIGINT NOT NULL DEFAULT 0,
    "status" "ApiKeyStatus" NOT NULL DEFAULT 'ACTIVE',
    "rate_limit_per_min" INTEGER NOT NULL DEFAULT 0,
    "max_concurrent" INTEGER NOT NULL DEFAULT 0,
    "created_by_admin_id" UUID,
    "last_used_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "token_transactions" (
    "id" UUID NOT NULL,
    "api_key_id" UUID NOT NULL,
    "admin_id" UUID,
    "amount" BIGINT NOT NULL,
    "type" "TransactionType" NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "token_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pool_providers" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "base_url" TEXT NOT NULL,
    "api_key_encrypted" TEXT NOT NULL,
    "api_key_last4" TEXT NOT NULL,
    "wire_api" "WireApi" NOT NULL DEFAULT 'CHAT',
    "priority" INTEGER NOT NULL DEFAULT 100,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "models" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "timeout_ms" INTEGER NOT NULL DEFAULT 600000,
    "last_health_check" TIMESTAMP(3),
    "last_health_ok" BOOLEAN,
    "last_health_latency_ms" INTEGER,
    "last_error_at" TIMESTAMP(3),
    "last_error_message" TEXT,
    "consecutive_errors" INTEGER NOT NULL DEFAULT 0,
    "circuit_open_until" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pool_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_logs" (
    "id" UUID NOT NULL,
    "api_key_id" UUID,
    "provider_id" UUID,
    "model" TEXT,
    "session_id" TEXT,
    "endpoint" TEXT NOT NULL,
    "streamed" BOOLEAN NOT NULL DEFAULT false,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "cached_tokens" INTEGER NOT NULL DEFAULT 0,
    "total_tokens" INTEGER NOT NULL DEFAULT 0,
    "accuracy" TEXT NOT NULL DEFAULT 'exact',
    "estimated_cost" DECIMAL(12,6),
    "latency_ms" INTEGER NOT NULL DEFAULT 0,
    "status_code" INTEGER NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_audit_logs" (
    "id" UUID NOT NULL,
    "admin_id" UUID,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT,
    "metadata" JSONB,
    "ip" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_pricing" (
    "id" UUID NOT NULL,
    "model_pattern" TEXT NOT NULL,
    "input_per_million" DECIMAL(12,6) NOT NULL,
    "output_per_million" DECIMAL(12,6) NOT NULL,
    "cached_per_million" DECIMAL(12,6),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "model_pricing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "routing_strategy" "RoutingStrategy" NOT NULL DEFAULT 'PRIORITY',
    "circuit_threshold" INTEGER NOT NULL DEFAULT 3,
    "circuit_cooldown_seconds" INTEGER NOT NULL DEFAULT 60,
    "log_retention_days" INTEGER NOT NULL DEFAULT 90,
    "default_rate_limit_per_min" INTEGER NOT NULL DEFAULT 120,
    "default_max_concurrent" INTEGER NOT NULL DEFAULT 8,
    "quota_warn_percent" INTEGER NOT NULL DEFAULT 10,
    "gateway_public_url" TEXT,
    "default_model" TEXT NOT NULL DEFAULT 'gpt-5-codex',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_status_idx" ON "users"("status");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys"("key_hash");

-- CreateIndex
CREATE INDEX "api_keys_user_id_idx" ON "api_keys"("user_id");

-- CreateIndex
CREATE INDEX "api_keys_status_idx" ON "api_keys"("status");

-- CreateIndex
CREATE INDEX "token_transactions_api_key_id_created_at_idx" ON "token_transactions"("api_key_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "pool_providers_name_key" ON "pool_providers"("name");

-- CreateIndex
CREATE INDEX "pool_providers_is_active_priority_idx" ON "pool_providers"("is_active", "priority");

-- CreateIndex
CREATE INDEX "usage_logs_api_key_id_created_at_idx" ON "usage_logs"("api_key_id", "created_at");

-- CreateIndex
CREATE INDEX "usage_logs_provider_id_created_at_idx" ON "usage_logs"("provider_id", "created_at");

-- CreateIndex
CREATE INDEX "usage_logs_created_at_idx" ON "usage_logs"("created_at");

-- CreateIndex
CREATE INDEX "admin_audit_logs_created_at_idx" ON "admin_audit_logs"("created_at");

-- CreateIndex
CREATE INDEX "admin_audit_logs_admin_id_created_at_idx" ON "admin_audit_logs"("admin_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "model_pricing_model_pattern_key" ON "model_pricing"("model_pattern");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_admin_id_fkey" FOREIGN KEY ("created_by_admin_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_transactions" ADD CONSTRAINT "token_transactions_api_key_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "api_keys"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_transactions" ADD CONSTRAINT "token_transactions_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_logs" ADD CONSTRAINT "usage_logs_api_key_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "api_keys"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_logs" ADD CONSTRAINT "usage_logs_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "pool_providers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_audit_logs" ADD CONSTRAINT "admin_audit_logs_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

