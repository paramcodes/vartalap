ALTER TABLE "account" ADD COLUMN "access_token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "refresh_token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "device_label" text;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "device_trusted" boolean DEFAULT false NOT NULL;