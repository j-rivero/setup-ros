import * as core from "@actions/core";
import * as io from "@actions/io";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import * as apt from "./package_manager/apt";
import * as pip from "./package_manager/pip";
import * as utils from "./utils";

const rosAptSourceRepository =
	"https://api.github.com/repos/ros-infrastructure/ros-apt-source/releases/latest";
const rosAptSourceDownloadBase =
	"https://github.com/ros-infrastructure/ros-apt-source/releases/download";
const aptSourcesListPath = "/etc/apt/sources.list";
const aptSourcesListDirectory = "/etc/apt/sources.list.d";

/**
 * Configure basic OS stuff.
 */
async function configOs(): Promise<void> {
	// When this action runs in a Docker image, sudo may be missing.
	// This installs sudo to avoid having to handle both cases (action runs as
	// root, action does not run as root) everywhere in the action.
	try {
		await io.which("sudo", true);
	} catch (err) {
		await utils.exec("apt-get", ["update"]);
		await utils.exec("apt-get", [
			"install",
			"--no-install-recommends",
			"--quiet",
			"--yes",
			"sudo",
		]);
	}

	await utils.exec("sudo", ["bash", "-c", "echo 'Etc/UTC' > /etc/timezone"]);
	await utils.exec("sudo", ["apt-get", "update"]);

	// Install tools required to configure the worker system.
	await apt.runAptGetInstall([
		"curl",
		"ca-certificates",
		"locales",
		"lsb-release",
	]);

	// Select a locale supporting Unicode.
	await utils.exec("sudo", ["locale-gen", "en_US", "en_US.UTF-8"]);
	core.exportVariable("LANG", "en_US.UTF-8");

	// Enforce UTC time for consistency.
	await utils.exec("sudo", ["bash", "-c", "echo 'Etc/UTC' > /etc/timezone"]);
	await utils.exec("sudo", [
		"ln",
		"-sf",
		"/usr/share/zoneinfo/Etc/UTC",
		"/etc/localtime",
	]);
	await apt.runAptGetInstall(["tzdata"]);
}

/**
 * Install the ROS APT source package for the current Ubuntu release.
 *
 * This is necessary even when building from source to install colcon, vcs, etc.
 */
async function installRosAptSourcePackage(
	aptSourcePackageName: string,
): Promise<void> {
	await utils.exec("bash", [
		"-c",
		`set -eo pipefail && export ROS_APT_SOURCE_VERSION=$(curl -s ${rosAptSourceRepository} | grep -F "tag_name" | awk -F'"' '{print $4}') && ubuntu_codename=$(. /etc/os-release && echo \${UBUNTU_CODENAME:-\${VERSION_CODENAME}}) && package_name="${aptSourcePackageName}" && curl --fail --location --retry 3 --retry-delay 2 -o "/tmp/\${package_name}.deb" "${rosAptSourceDownloadBase}/\${ROS_APT_SOURCE_VERSION}/\${package_name}_\${ROS_APT_SOURCE_VERSION}.\${ubuntu_codename}_all.deb" && sudo dpkg -i "/tmp/\${package_name}.deb" && rm -f "/tmp/\${package_name}.deb"`,
	]);
	await utils.exec("sudo", ["apt-get", "update"]);
}

// Ubuntu distribution for ROS 1
const ros1UbuntuVersion = "focal";

function getRos2AptRepositoryPath(use_ros2_testing: boolean): string {
	return `/ros2${use_ros2_testing ? "-testing" : ""}/ubuntu`;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getRos2AptRepositoryUrlPattern(use_ros2_testing: boolean): string {
	return `https?:\\/\\/packages\\.ros\\.org${escapeRegExp(getRos2AptRepositoryPath(use_ros2_testing))}\\/?`;
}

function isRequestedRos2RepositoryConfiguredInListFile(
	fileContents: string,
	ubuntuCodename: string,
	use_ros2_testing: boolean,
): boolean {
	const repositoryPattern = new RegExp(
		`^deb(?:-src)?\\s+(?:\\[[^\\]]*\\]\\s+)?${getRos2AptRepositoryUrlPattern(use_ros2_testing)}\\s+${escapeRegExp(ubuntuCodename)}(?:\\s|$)`,
	);

	return fileContents.split("\n").some((line) => {
		const trimmedLine = line.trim();
		return (
			trimmedLine !== "" &&
			!trimmedLine.startsWith("#") &&
			repositoryPattern.test(trimmedLine)
		);
	});
}

function isRequestedRos2RepositoryConfiguredInSourcesFile(
	fileContents: string,
	ubuntuCodename: string,
	use_ros2_testing: boolean,
): boolean {
	const suitePattern = new RegExp(
		`^Suites:\\s+.*\\b${escapeRegExp(ubuntuCodename)}\\b.*$`,
		"m",
	);
	const uriPattern = new RegExp(
		`^URIs:\\s+(?:\\S+\\s+)*${getRos2AptRepositoryUrlPattern(use_ros2_testing)}(?:\\s+\\S+)*$`,
		"m",
	);

	return fileContents
		.split(/\n\s*\n/)
		.map((stanza) =>
			stanza
				.split("\n")
				.filter((line) => !line.trim().startsWith("#"))
				.join("\n"),
		)
		.some((stanza) => uriPattern.test(stanza) && suitePattern.test(stanza));
}

function isRequestedRos2RepositoryConfiguredInSourceFile(
	aptSourceFile: { path: string; content: string },
	ubuntuCodename: string,
	use_ros2_testing: boolean,
): boolean {
	if (path.extname(aptSourceFile.path) === ".sources") {
		return isRequestedRos2RepositoryConfiguredInSourcesFile(
			aptSourceFile.content,
			ubuntuCodename,
			use_ros2_testing,
		);
	}

	return isRequestedRos2RepositoryConfiguredInListFile(
		aptSourceFile.content,
		ubuntuCodename,
		use_ros2_testing,
	);
}

async function readAptSourceFiles(): Promise<
	Array<{ path: string; content: string }>
> {
	const aptSourcePaths = [aptSourcesListPath];

	try {
		const sourceEntries = await fs.readdir(aptSourcesListDirectory, {
			withFileTypes: true,
		});
		for (const sourceEntry of sourceEntries) {
			if (sourceEntry.isFile()) {
				aptSourcePaths.push(
					path.join(aptSourcesListDirectory, sourceEntry.name),
				);
			}
		}
	} catch (error) {
		if (!(error instanceof Error) || "code" in error === false) {
			throw error;
		}

		if (error.code !== "ENOENT") {
			throw error;
		}
	}

	const aptSourceFiles: Array<{ path: string; content: string }> = [];
	for (const aptSourcePath of aptSourcePaths) {
		try {
			aptSourceFiles.push({
				path: aptSourcePath,
				content: await fs.readFile(aptSourcePath, "utf8"),
			});
		} catch (error) {
			if (!(error instanceof Error) || "code" in error === false) {
				throw error;
			}

			if (error.code !== "ENOENT") {
				throw error;
			}
		}
	}

	return aptSourceFiles;
}

export function shouldInstallRosAptSourcePackage(
	ubuntuCodename: string,
	use_ros2_testing: boolean,
	aptSourceFiles: Array<{ path: string; content: string }>,
): boolean {
	if (ubuntuCodename === ros1UbuntuVersion) {
		return true;
	}

	return !aptSourceFiles.some((aptSourceFile) =>
		isRequestedRos2RepositoryConfiguredInSourceFile(
			aptSourceFile,
			ubuntuCodename,
			use_ros2_testing,
		),
	);
}

/**
 * Determine the ROS APT source package to install.
 *
 * @param ubuntuCodename the Ubuntu version codename
 */
function determineAptSourcePackageName(
	ubuntuCodename: string,
	use_ros2_testing: boolean,
): string {
	// There is now no Ubuntu version overlap between ROS 1 and ROS 2.
	if (ros1UbuntuVersion === ubuntuCodename) {
		return "ros-apt-source";
	}

	return `ros2${use_ros2_testing ? "-testing" : ""}-apt-source`;
}

/**
 * Initialize rosdep.
 */
async function rosdepInit(): Promise<void> {
	/**
	 * Try to remove the default file first in case this environment has already done a rosdep
	 * init before.
	 */
	await utils.exec("sudo", [
		"bash",
		"-c",
		"rm /etc/ros/rosdep/sources.list.d/20-default.list || true",
	]);
	await utils.exec("sudo", ["rosdep", "init"]);
}

/**
 * Install ROS 1 or 2 (development packages and/or ROS binaries) on a Linux worker.
 */
export async function runLinux(): Promise<void> {
	// Get user input & validate
	const use_ros2_testing = core.getInput("use-ros2-testing") === "true";
	const installConnext = core.getInput("install-connext") === "true";

	await configOs();

	const ubuntuCodename = await utils.determineDistribCodename();
	const aptSourcePackageName = determineAptSourcePackageName(
		ubuntuCodename,
		use_ros2_testing,
	);
	const aptSourceFiles = await readAptSourceFiles();

	if (
		shouldInstallRosAptSourcePackage(
			ubuntuCodename,
			use_ros2_testing,
			aptSourceFiles,
		)
	) {
		await installRosAptSourcePackage(aptSourcePackageName);
	} else {
		core.info(
			`Skipping ${aptSourcePackageName}; the requested ROS 2 APT repository is already configured.`,
		);
	}

	if ("noble" !== ubuntuCodename) {
		// Temporary fix to avoid error mount: /var/lib/grub/esp: special device (...) does not exist.
		const arch = await utils.getArch();
		await utils.exec("sudo", ["apt-mark", "hold", `grub-efi-${arch}-signed`]);
		await utils.exec("sudo", ["apt-get", "upgrade", "-y"]);
	}

	// Install development-related packages and some common dependencies
	await apt.installAptDependencies(installConnext);

	// We don't use pip here to install dependencies for ROS 2
	if (ubuntuCodename === ros1UbuntuVersion) {
		/* pip3 dependencies need to be installed after the APT ones, as pip3
		modules such as cryptography requires python-dev to be installed,
		because they rely on Python C headers. */
		await pip.installPython3Dependencies();
	}

	await rosdepInit();

	for (const rosDistro of utils.getRequiredRosDistributions()) {
		await apt.runAptGetInstall([`ros-${rosDistro}-desktop`]);
	}
}
