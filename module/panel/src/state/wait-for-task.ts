import { api } from '@/api'
import type { Task } from '@/api/contract'

const isRunning = ({ state }: Task) => state === 'pending' || state === 'running'

export function waitForTask(first: Task, onProgress?: (task: Task) => void): Promise<Task> {
  if (!isRunning(first)) return Promise.resolve(first)

  // Follow tasks independently of the screen that started them.
  return new Promise((resolve, reject) => {
    let timer: number | undefined
    let reading = false
    let eventsWhileReading = false
    let missing = 0
    const schedule = (delay: number) => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => void read(), delay)
    }
    const read = async () => {
      if (reading) return
      reading = true
      eventsWhileReading = false
      try {
        const task = (await api.getTasks()).find(({ id }) => id === first.id)
        if (task) {
          missing = 0
          if (!isRunning(task)) {
            stop()
            resolve(task)
            return
          }
          onProgress?.(task)
        } else if (++missing >= 3) {
          stop()
          reject(new Error('Задача больше недоступна. Проверьте её состояние в центре задач.'))
          return
        }
      } catch {
        // A temporary connection failure does not stop the server-side task.
      } finally {
        reading = false
      }
      schedule(eventsWhileReading ? 0 : 2000)
    }
    const unsubscribe = api.subscribe((topic) => {
      if (topic !== 'tasks') return
      if (reading) eventsWhileReading = true
      else schedule(0)
    })
    const stop = () => {
      unsubscribe()
      window.clearTimeout(timer)
    }
    schedule(0)
  })
}
