# Family Allowance Tracker v6

## New in v6
- Parent email/password login
- Viewer User ID + PIN login
- New viewer requests start as `pending`
- Parent screen to approve/remove viewer access
- Approved viewers are read-only
- Viewers can see both children, with each child's current allowance and activity grouped under that child

## Upgrade
1. Keep your existing Supabase project and data.
2. Run `supabase/migration_v6.sql` in Supabase SQL Editor.
3. In Supabase Authentication settings, disable **Confirm email** if you want synthetic User ID viewer accounts to work without email confirmation.
4. Run `npm install` and `npm run dev`.

Use a 6+ digit PIN for viewer accounts.

# v6.1 viewer access update

This version removes viewer `signUp()` from the browser. That fixes the Supabase email rate-limit problem.

## Viewer flow

1. Viewer requests a User ID only.
2. Parent opens **More → Viewer approvals**.
3. Parent approves the request and sets a 6+ digit PIN.
4. A secure Supabase Edge Function creates the actual Auth account with `email_confirm: true`.
5. Viewer signs in using only the User ID + PIN shown in the app.

No confirmation email is sent to viewers.

## Upgrade steps

### 1. Run the SQL migration
Run only:

`supabase/migration_v6_1.sql`

Do **not** rerun `schema.sql`.

### 2. Deploy the Edge Functions
With the Supabase CLI linked to your existing project:

```powershell
supabase functions deploy request-viewer-access
supabase functions deploy approve-viewer
```

The Edge Functions use Supabase's built-in `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` environment variables. Do not put the service-role key in your React `.env.local` file.

### 3. Start the app

```powershell
npm install
npm run dev
```

## Existing data

The v6.1 migration adds only the `viewer_requests` table and policies. It does not delete or reset your existing children, transactions, allowances, rules, settings, or parent accounts.
