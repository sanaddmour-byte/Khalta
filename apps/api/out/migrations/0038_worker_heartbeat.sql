CREATE TABLE "worker_heartbeats" (
	"name" text PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" text
);
