import { execSync } from 'child_process';

const MULTICAST_ADDRESS = '239.0.0.1';

if (process.platform === 'linux') {
    let hasRoute = false;
    try {
        const output = execSync(`ip route show ${MULTICAST_ADDRESS}`, { encoding: 'utf8' });
        hasRoute = output.trim().length > 0;
    } catch {
        hasRoute = false;
    }

    if (!hasRoute) {
        console.error(`\nERROR: Multicast route not configured for ${MULTICAST_ADDRESS}.`);
        console.error(`run this command before running tests: 'sudo ip route add ${MULTICAST_ADDRESS} dev lo'`);
        console.error('Skipping tests.\n');
        process.exit(1);
    }
}
