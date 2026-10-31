# Prompt Practice

A self-paced workplace AI course with three lessons, a 10-question interactive quiz, learner progress tracking, and an admin review inbox. Course text and quiz content are drawn only from `Treat_AI_Like_a_Colleague.txt` and `Using_AI_Responsibly.txt`.

## Run locally

Requires Node.js 20 or newer; no third-party packages are needed.

1. Set an admin key in your terminal, then start the server:

   **PowerShell**
   ```powershell
   $env:AI_COURSE_ADMIN_KEY = "use-a-random-secret-of-at-least-32-characters"
   npm start
   ```

   **macOS/Linux**
   ```sh
   AI_COURSE_ADMIN_KEY="use-a-random-secret-of-at-least-32-characters" npm start
   ```

2. Open `http://localhost:8000` for learners. Open `http://localhost:8000/admin` separately for the admin review inbox, then enter the same key to view submissions or export them as CSV. The student course does not link to the admin portal.

Submissions are saved in `storage/submissions.json`; that directory is excluded from Git. The server calculates quiz scores from submitted answers, validates each response, limits submission volume, restricts public files to the course pages, and protects admin records with a constant-time secret-key check. Lesson progress remains in the learner's browser until quiz submission.

## Deploy on Render

`render.yaml` defines a Render web service, a generated admin secret, a health check, and a persistent disk for learner records. The service is configured for a paid compute plan because Render's free web services do not support persistent disks; free Postgres also expires after 30 days. Render requires a repository connected to your Render account to create the service. After connecting this project, create a Blueprint from `render.yaml`; Render generates `AI_COURSE_ADMIN_KEY`. Copy that value from the service's Environment settings for admin sign-in.

The public course URL will be the Render service URL; the admin page is at `/admin`. The admin page is not linked from the learner course. The course server records results for admin review; it does not send email. Student names and email addresses are self-entered and are not identity-verified.
