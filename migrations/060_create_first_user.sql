-- Create first admin user
INSERT INTO users (display_name, invite_code, status)
VALUES ('Admin', 'MYA-INVITE-2026', 'pending')
ON CONFLICT (invite_code) DO NOTHING;
