import http from 'node:http'

const port = Number(process.env.MOCK_HOOK_PORT || 3101)
const completedTasks = new Set()

function sendJson(response, status, data) {
	response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
	response.end(JSON.stringify(data))
}

const server = http.createServer((request, response) => {
	if (request.method !== 'POST' || request.url !== '/callback') {
		sendJson(response, 404, { message: 'route not found' })
		return
	}

	let rawBody = ''
	request.setEncoding('utf8')
	request.on('data', (chunk) => {
		rawBody += chunk
	})
	request.on('end', () => {
		try {
			const body = JSON.parse(rawBody)
			const taskIds = Array.isArray(body.taskIds) ? body.taskIds.filter((taskId) => typeof taskId === 'string') : []

			if (body.type === 'run') {
				for (const taskId of taskIds) completedTasks.add(taskId)
				console.log(`[run] queue=${body.namespace}/${body.queueId} tasks=${taskIds.join(',')}`)
				sendJson(response, 200, { data: { taskIds: [] } })
				return
			}

			if (body.type === 'check') {
				const completed = taskIds.filter((taskId) => completedTasks.delete(taskId))
				console.log(`[check] completed=${completed.join(',') || '-'}`)
				sendJson(response, 200, { data: { taskIds: completed } })
				return
			}

			if (body.type === 'expire') {
				console.log(`[expire] queue=${body.namespace}/${body.queueId}`)
				sendJson(response, 200, { data: { taskIds: [] } })
				return
			}

			sendJson(response, 400, { message: 'unsupported callback type' })
		} catch (error) {
			sendJson(response, 400, { message: error instanceof Error ? error.message : 'invalid request' })
		}
	})
})

server.listen(port, '127.0.0.1', () => {
	console.log(`mock hook listening at http://127.0.0.1:${port}/callback`)
})
