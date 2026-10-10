-- AU1 (SPEC-auth §5.1, ADR-057): bảng danh tính người dùng. Sinh bằng prisma migrate diff (khớp schema.prisma).
-- Bảng danh tính KHÔNG mang dữ liệu nghiệp vụ của tenant, tra trước khi biết tenant -> không bật RLS (AU6).

-- CreateEnum
CREATE TYPE "hub"."MemberRole" AS ENUM ('owner', 'developer', 'viewer');

-- CreateEnum
CREATE TYPE "hub"."TokenPurpose" AS ENUM ('verify_email', 'reset_password', 'invite');

-- CreateTable
CREATE TABLE "hub"."users" (
    "id" UUID NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "password_hash" TEXT,
    "email_verified_at" TIMESTAMPTZ(6),
    "github_id" VARCHAR(32),
    "is_operator" BOOLEAN NOT NULL DEFAULT false,
    "password_changed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hub"."project_members" (
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "hub"."MemberRole" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_members_pkey" PRIMARY KEY ("tenant_id","user_id")
);

-- CreateTable
CREATE TABLE "hub"."auth_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "replaced_by_id" UUID,
    "rotated_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "revoke_reason" VARCHAR(32),
    "idle_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "absolute_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "user_agent" VARCHAR(255),
    "ip" VARCHAR(45),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hub"."email_tokens" (
    "id" UUID NOT NULL,
    "purpose" "hub"."TokenPurpose" NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "user_id" UUID,
    "tenant_id" UUID,
    "role" "hub"."MemberRole",
    "invited_by" UUID,
    "token_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hub"."auth_audit" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "action" VARCHAR(64) NOT NULL,
    "ip" VARCHAR(45),
    "meta" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_audit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "hub"."users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_github_id_key" ON "hub"."users"("github_id");

-- CreateIndex
CREATE INDEX "project_members_user_id_idx" ON "hub"."project_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "auth_sessions_token_hash_key" ON "hub"."auth_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "auth_sessions_user_id_idx" ON "hub"."auth_sessions"("user_id");

-- CreateIndex
CREATE INDEX "auth_sessions_family_id_idx" ON "hub"."auth_sessions"("family_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_tokens_token_hash_key" ON "hub"."email_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "email_tokens_email_purpose_idx" ON "hub"."email_tokens"("email", "purpose");

-- CreateIndex
CREATE INDEX "auth_audit_user_id_created_at_idx" ON "hub"."auth_audit"("user_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "hub"."project_members" ADD CONSTRAINT "project_members_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "hub"."projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hub"."project_members" ADD CONSTRAINT "project_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "hub"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hub"."auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "hub"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

