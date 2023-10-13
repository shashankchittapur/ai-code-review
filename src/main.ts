import * as core from '@actions/core'
import * as github from '@actions/github'
import { Configuration, OpenAIApi } from 'openai'
import parseDiff from 'parse-diff'

interface Inputs {
  token: string
  open_api_token: string
  model_name: string
}

interface AIComment {
  body: string
  path: string
  line: number
}

interface PRDetails {
  owner: string
  repo: string
  pull_number: number
  title: string
  description: string
}

const inputs: Inputs = {
  token: core.getInput('GITHUB_TOKEN'),
  open_api_token: core.getInput('OPEN_API_TOKEN'),
  model_name: core.getInput('OPEN_API_MODEL')
}

const octokit = github.getOctokit(inputs.token)
const configuration = new Configuration({
  apiKey: inputs.open_api_token,
  organization: 'org-zbPJye4lMDb8X1x6YwUKp3Xa'
})
const openai = new OpenAIApi(configuration)

/**
 * Gets the pull request details from the context.
 * @param {string} token - The GitHub token to use for authentication.
 * @returns {Promise<PRDetails>} The pull request details.
 */

async function getPRDetails(): Promise<PRDetails> {
  const context = github.context
  const pr = context.payload.pull_request

  if (!pr) {
    throw new Error('Could not get pull request details from context, exiting')
  }

  return {
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: pr.number,
    title: pr.title,
    description: pr.body?.trim() ?? ''
  }
}

/**
 * Gets the diff of the pull request.
 * @param {string} owner - The owner of the repository.
 * @param {string} repo - The name of the repository.
 * @param {number} pull_number - The number of the pull request.
 * @returns {Promise<string>} The diff of the pull request.
 */
async function getDiff(
  owner: string,
  repo: string,
  pull_number: number
): Promise<string | null> {
  try {
    const response = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number,
      mediaType: { format: 'diff' }
    })
    // @ts-expect-error - response.data is a string
    return response.data
  } catch (error) {
    core.error(`Error getting diff: ${error}`)
    return null
  }
}
/**
 * The main function for the action.
 * @returns {Promise<void>} Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  try {
    // Get the inputs from the workflow file:

    const prDetails = await getPRDetails()
    core.debug(`PR Details: ${JSON.stringify(prDetails)}`)
    let diff: any = null
    // Check if PR is Opened or Synced
    const prAction = github.context.payload.action
    if (prAction === 'opened') {
      core.info('PR Opened')
      diff = await getDiff(
        prDetails.owner,
        prDetails.repo,
        prDetails.pull_number
      )
    } else if (prAction === 'synchronize') {
      const newBaseSha = github.context.payload.after
      const oldBaseSha = github.context.payload.before

      if (!newBaseSha || !oldBaseSha) {
        throw new Error('Could not get base SHAs from context, exiting')
      }

      // compare the two base SHAs to get the diff
      try {
        const response = await octokit.rest.repos.compareCommits({
          owner: prDetails.owner,
          repo: prDetails.repo,
          base: oldBaseSha,
          head: newBaseSha
        })
        const files = response.data.files
        if (files) {
          diff = files
            .map((file: any) => {
              return file.patch
            })
            .join('\n')
        }
      } catch (error) {
        core.error(`Error getting diff: ${error}`)
        diff = null
      }
    }
    if (!diff) {
      core.warning('Could not get diff, exiting')
    }
    core.debug(`Diff: ${diff}`)

    const parsedDiff = parseDiff(diff)
    core.debug(`Parsed Diff: ${JSON.stringify(parsedDiff)}`)

    const comments: AIComment[] = await analyzeCode(parsedDiff, prDetails)

    core.info(`Comments: ${JSON.stringify(comments)}`)
    if (comments.length > 0) {
      await createReviewComment(
        prDetails.owner,
        prDetails.repo,
        prDetails.pull_number,
        comments
      )
    }
  } catch (error) {
    // Fail the workflow run if an error occurs
    if (error instanceof Error) core.setFailed(error.message)
  }
}

/**
 * Analyzes the code diff and creates review comments.
 * @param {string} diff - The diff of the pull request.
 * @param {PRDetails} prDetails - The pull request details.
 * @returns {Promise<void>} Resolves when the action is complete.
 * @returns {Promise<Array<{ body: string; path: string; line: number }>>} The review comments.
 * @returns {Promise<null>} If there is an error.
 */
//"@typescript-eslint/array-type": ["error", { "default": "generic" }]
async function analyzeCode(
  parsedDiff: parseDiff.File[],
  prDetails: PRDetails
): Promise<AIComment[]> {
  const comments: AIComment[] = []
  core.info('Starting to analyze code')
  for (const file of parsedDiff) {
    if (file.to === '/dev/null') continue // Ignore deleted files
    for (const chunk of file.chunks) {
      const prompt = createPrompt(file, chunk, prDetails)
      const aiResponse = await getAIResponse(prompt)
      if (aiResponse) {
        const newComments = createComment(file, chunk, aiResponse)
        if (newComments) {
          comments.push(...newComments)
        }
      }
    }
  }
  core.info('Finished analyzing code')
  return comments
}

interface AIResponse {
  lineNumber: string
  reviewComment: string
}

/**
 * Gets the AI response.
 * @param {string} prompt - The prompt for the AI.
 * @returns {Promise<Array<{ lineNumber: string; reviewComment: string }>>} The AI response.
 * @returns {Promise<null>} If there is an error.
 */
async function getAIResponse(prompt: string): Promise<AIResponse[] | null> {
  const queryConfig = {
    model: inputs.model_name,
    temperature: 0.2,
    max_tokens: 700,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0
  }

  try {
    const response = await openai.createChatCompletion({
      ...queryConfig,
      messages: [
        {
          role: 'system',
          content: prompt
        }
      ]
    })

    const res = response.data.choices[0].message?.content?.trim() ?? '[]'
    return JSON.parse(res)
  } catch (error) {
    console.error('Error:', error)
    return null
  }
}

function createComment(
  file: parseDiff.File,
  chunk: parseDiff.Chunk,
  aiResponses: AIResponse[]
): AIComment[] {
  return aiResponses.flatMap(aiResponse => {
    const path = file.to || file.from // Use from if to is undefined
    return [
      {
        body: aiResponse.reviewComment,
        path,
        line: Number(aiResponse.lineNumber)
      } as AIComment // Cast to AIComment to fix type error
    ]
  })
}

async function createReviewComment(
  owner: string,
  repo: string,
  pull_number: number,
  comments: AIComment[]
): Promise<void> {
  const reviewComments = comments.map(comment => {
    return {
      path: comment.path,
      position: comment.line,
      body: comment.body
    }
  })

  await octokit.rest.pulls.createReview({
    owner,
    repo,
    pull_number,
    event: 'COMMENT',
    body: 'AI Review',
    comments: reviewComments
  })
}

function createPrompt(
  file: parseDiff.File,
  chunk: parseDiff.Chunk,
  prDetails: PRDetails
): string {
  return `Your task is to review pull requests. Instructions:
- Provide the response in following JSON format:  [{"lineNumber":  <line_number>, "reviewComment": "<review comment>"}]
- Do not give positive comments or compliments.
- Provide comments and suggestions ONLY if there is something to improve, otherwise return an empty array.
- Write the comment in GitHub Markdown format.
- Use the given description only for the overall context and only comment the code.
- IMPORTANT: NEVER suggest adding comments to the code.

Review the following code diff in the file "${
    file.to
  }" and take the pull request title and description into account when writing the response.
  
Pull request title: ${prDetails.title}
Pull request description:

---
${prDetails.description}
---

Git diff to review:

\`\`\`diff
${chunk.content}
${chunk.changes
  // @ts-expect-error - ln and ln2 exists where needed
  .map(c => `${c.ln ? c.ln : c.ln2} ${c.content}`)
  .join('\n')}
\`\`\`
`
}
