DROP INDEX "user_username_lower_key";--> statement-breakpoint
ALTER TABLE "handle_reservation" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "handle_reservation" ADD COLUMN "reason" text DEFAULT 'released' NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "image" text;--> statement-breakpoint
CREATE UNIQUE INDEX "user_username_unique" ON "user" USING btree ("username");--> statement-breakpoint
CREATE UNIQUE INDEX "user_username_lower_key" ON "user" USING btree (lower("username" COLLATE "C"));