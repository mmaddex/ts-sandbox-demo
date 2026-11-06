// A follow-on pipeline step: formats the output of zod-axios. Runs with no network access.
type Repo = { repo: string; stars: number; license: string | null };

export default function (input: Repo) {
  const stars = input.stars.toLocaleString("en-US");
  console.log(`Summarizing ${input.repo}`);
  return { summary: `${input.repo} has ${stars} stars and ${input.license ?? "no"} license.` };
}
