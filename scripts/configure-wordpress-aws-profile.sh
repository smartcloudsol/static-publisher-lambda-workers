#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -lt 2 || "$#" -gt 4 ]]; then
  printf '%s\n' \
    'Usage: configure-wordpress-aws-profile.sh PROFILE ROLE_ARN [REGION] [EXTERNAL_ID]' >&2
  exit 2
fi

PROFILE="$1"
ROLE_ARN="$2"
REGION="${3:-eu-central-1}"
EXTERNAL_ID="${4:-}"

if [[ ! "$PROFILE" =~ ^[A-Za-z0-9][A-Za-z0-9_.@+=,-]{0,127}$ ]]; then
  printf 'Invalid AWS profile name: %s\n' "$PROFILE" >&2
  exit 2
fi
if [[ ! "$ROLE_ARN" =~ ^arn:(aws|aws-cn|aws-us-gov|aws-iso|aws-iso-b):iam::[0-9]{12}:role/([A-Za-z0-9_+=,.@-]+/)*[A-Za-z0-9_+=,.@-]{1,64}$ ]]; then
  printf '%s\n' 'Invalid IAM role ARN.' >&2
  exit 2
fi
if [[ -n "$EXTERNAL_ID" && ( ${#EXTERNAL_ID} -lt 2 || ${#EXTERNAL_ID} -gt 1224 || ! "$EXTERNAL_ID" =~ ^[A-Za-z0-9_+=,.@:/-]+$ ) ]]; then
  printf '%s\n' 'Invalid external ID.' >&2
  exit 2
fi
if [[ ! "$REGION" =~ ^(af|ap|ca|cn|eu|il|me|mx|sa|us)(-[a-z0-9]+)+-[0-9]+$ ]]; then
  printf 'Invalid AWS Region: %s\n' "$REGION" >&2
  exit 2
fi

aws configure set role_arn "$ROLE_ARN" --profile "$PROFILE"
aws configure set credential_source Ec2InstanceMetadata --profile "$PROFILE"
if [[ -n "$EXTERNAL_ID" ]]; then
  aws configure set external_id "$EXTERNAL_ID" --profile "$PROFILE"
fi
aws configure set role_session_name "wpsuite-${PROFILE:0:55}" --profile "$PROFILE"
aws configure set region "$REGION" --profile "$PROFILE"

CONFIG_FILE="${AWS_CONFIG_FILE:-${HOME}/.aws/config}"
chmod 0600 "$CONFIG_FILE"

AWS_PROFILE="$PROFILE" aws sts get-caller-identity --output json
