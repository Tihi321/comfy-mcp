import { main } from './patches'

process.exitCode = main(process.argv.slice(2))
