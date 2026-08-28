CREATE TABLE "comments" (
	"id" serial PRIMARY KEY,
	"post_slug" text NOT NULL,
	"user_id" text NOT NULL,
	"user_name" text NOT NULL,
	"user_email" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone,
	"status" text DEFAULT 'published' NOT NULL,
	"likes" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX "comments_post_slug_idx" ON "comments" ("post_slug","created_at");