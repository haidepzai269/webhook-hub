-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "hub";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "shop";

-- CreateEnum
CREATE TYPE "hub"."ProviderEnum" AS ENUM ('payos', 'sepay', 'github', 'stripe');

-- CreateEnum
CREATE TYPE "hub"."RawStatus" AS ENUM ('ACCEPTED', 'REJECTED', 'DUPLICATE');

-- CreateEnum
CREATE TYPE "hub"."EventOrigin" AS ENUM ('webhook', 'reconciliation', 'replay', 'derived');

-- CreateEnum
CREATE TYPE "hub"."DestinationType" AS ENUM ('webhook', 'telegram', 'discord');

-- CreateEnum
CREATE TYPE "hub"."DeliveryStatus" AS ENUM ('PENDING', 'DELIVERING', 'RETRYING', 'SUCCEEDED', 'DEAD');

-- CreateEnum
CREATE TYPE "hub"."CircuitState" AS ENUM ('CLOSED', 'OPEN', 'HALF_OPEN');

-- CreateTable
CREATE TABLE "hub"."sources" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "provider" "hub"."ProviderEnum" NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "source_key" VARCHAR(64) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hub"."source_secrets" (
    "id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "secret_encrypted" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "valid_from" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "valid_until" TIMESTAMPTZ(6),

    CONSTRAINT "source_secrets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hub"."raw_events" (
    "id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "idempotency_key" VARCHAR(255) NOT NULL,
    "headers" JSONB NOT NULL,
    "body" JSONB NOT NULL,
    "body_raw" BYTEA NOT NULL,
    "content_type" VARCHAR(128),
    "signature_header" TEXT,
    "signature_valid" BOOLEAN NOT NULL,
    "status" "hub"."RawStatus" NOT NULL DEFAULT 'ACCEPTED',
    "origin" "hub"."EventOrigin" NOT NULL DEFAULT 'webhook',
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "raw_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hub"."events" (
    "id" VARCHAR(36) NOT NULL,
    "tenant_id" UUID NOT NULL,
    "raw_event_id" UUID,
    "parent_event_id" VARCHAR(36),
    "idempotency_key" VARCHAR(255) NOT NULL,
    "correlation_id" UUID NOT NULL,
    "type" VARCHAR(128) NOT NULL,
    "source" VARCHAR(64) NOT NULL,
    "subject" VARCHAR(255),
    "data" JSONB NOT NULL,
    "origin" "hub"."EventOrigin" NOT NULL DEFAULT 'webhook',
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hub"."destinations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "type" "hub"."DestinationType" NOT NULL,
    "config_encrypted" TEXT NOT NULL,
    "signing_secret_encrypted" TEXT,
    "rate_limit_rps" INTEGER NOT NULL DEFAULT 0,
    "circuit_state" "hub"."CircuitState" NOT NULL DEFAULT 'CLOSED',
    "alert_on_open" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "destinations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hub"."subscriptions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "destination_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "event_types" TEXT[],
    "template" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hub"."deliveries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "event_id" VARCHAR(36) NOT NULL,
    "subscription_id" UUID NOT NULL,
    "attempt_generation" INTEGER NOT NULL DEFAULT 1,
    "status" "hub"."DeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hub"."delivery_attempts" (
    "id" BIGSERIAL NOT NULL,
    "delivery_id" UUID NOT NULL,
    "attempt_no" INTEGER NOT NULL,
    "request_body" JSONB,
    "response_status" INTEGER,
    "response_body" TEXT,
    "duration_ms" INTEGER,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hub"."outbox" (
    "id" BIGSERIAL NOT NULL,
    "topic" VARCHAR(128) NOT NULL,
    "payload" JSONB NOT NULL,
    "published_at" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hub"."processed_messages" (
    "consumer" VARCHAR(64) NOT NULL,
    "message_id" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_messages_pkey" PRIMARY KEY ("consumer","message_id")
);

-- CreateTable
CREATE TABLE "hub"."audit_logs" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" UUID NOT NULL,
    "action" VARCHAR(64) NOT NULL,
    "entity_type" VARCHAR(64) NOT NULL,
    "entity_id" VARCHAR(255) NOT NULL,
    "actor" VARCHAR(128) NOT NULL DEFAULT 'system',
    "reason" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shop"."orders" (
    "id" UUID NOT NULL,
    "order_code" VARCHAR(64) NOT NULL,
    "amount" BIGINT NOT NULL,
    "paid_amount" BIGINT NOT NULL DEFAULT 0,
    "status" VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    "payment_provider" VARCHAR(32),
    "payos_payment_link_id" VARCHAR(128),
    "version" INTEGER NOT NULL DEFAULT 1,
    "items" JSONB NOT NULL DEFAULT '[]',
    "customer" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shop"."processed_hub_events" (
    "event_id" VARCHAR(128) NOT NULL,
    "order_id" UUID NOT NULL,
    "amount" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_hub_events_pkey" PRIMARY KEY ("event_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sources_source_key_key" ON "hub"."sources"("source_key");

-- CreateIndex
CREATE INDEX "raw_events_received_at_idx" ON "hub"."raw_events"("received_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "raw_events_source_id_idempotency_key_key" ON "hub"."raw_events"("source_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "events_raw_event_id_key" ON "hub"."events"("raw_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "events_idempotency_key_key" ON "hub"."events"("idempotency_key");

-- CreateIndex
CREATE INDEX "events_tenant_id_received_at_idx" ON "hub"."events"("tenant_id", "received_at" DESC);

-- CreateIndex
CREATE INDEX "events_correlation_id_idx" ON "hub"."events"("correlation_id");

-- CreateIndex
CREATE INDEX "events_type_idx" ON "hub"."events"("type");

-- CreateIndex
CREATE INDEX "deliveries_tenant_id_status_next_attempt_at_idx" ON "hub"."deliveries"("tenant_id", "status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "deliveries_tenant_id_created_at_idx" ON "hub"."deliveries"("tenant_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "deliveries_event_id_subscription_id_attempt_generation_key" ON "hub"."deliveries"("event_id", "subscription_id", "attempt_generation");

-- CreateIndex
CREATE INDEX "delivery_attempts_delivery_id_idx" ON "hub"."delivery_attempts"("delivery_id");

-- CreateIndex
CREATE INDEX "outbox_id_idx" ON "hub"."outbox"("id");

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_created_at_idx" ON "hub"."audit_logs"("tenant_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "orders_order_code_key" ON "shop"."orders"("order_code");

-- CreateIndex
CREATE INDEX "orders_status_created_at_idx" ON "shop"."orders"("status", "created_at");

-- CreateIndex
CREATE INDEX "processed_hub_events_order_id_idx" ON "shop"."processed_hub_events"("order_id");

-- AddForeignKey
ALTER TABLE "hub"."source_secrets" ADD CONSTRAINT "source_secrets_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "hub"."sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hub"."raw_events" ADD CONSTRAINT "raw_events_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "hub"."sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hub"."events" ADD CONSTRAINT "events_raw_event_id_fkey" FOREIGN KEY ("raw_event_id") REFERENCES "hub"."raw_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hub"."subscriptions" ADD CONSTRAINT "subscriptions_destination_id_fkey" FOREIGN KEY ("destination_id") REFERENCES "hub"."destinations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hub"."deliveries" ADD CONSTRAINT "deliveries_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "hub"."events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hub"."deliveries" ADD CONSTRAINT "deliveries_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "hub"."subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hub"."delivery_attempts" ADD CONSTRAINT "delivery_attempts_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "hub"."deliveries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop"."processed_hub_events" ADD CONSTRAINT "processed_hub_events_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "shop"."orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

