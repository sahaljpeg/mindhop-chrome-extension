#!/bin/bash
set -e

# Usage: ./push_to_github.sh <remote-repo-url> [branch]
# Example: ./push_to_github.sh https://github.com/USERNAME/mindhop-chrome-extension.git main

if [ -z "$1" ]; then
  echo "Usage: $0 <remote-repo-url> [branch]"
  exit 1
fi

REMOTE=$1
BRANCH=${2:-main}

# Initialize repository if needed
if [ ! -d .git ]; then
  git init
  git add .
  git commit -m "Initial import of mindhop project"
else
  git add .
  # commit if there are changes
  if ! git diff --cached --quiet; then
    git commit -m "Update: import mindhop project" || true
  fi
fi

# Add or update remote
if git remote | grep -q origin; then
  git remote set-url origin "$REMOTE"
else
  git remote add origin "$REMOTE"
fi

# Ensure branch name and push
git branch -M "$BRANCH"
git push -u origin "$BRANCH"
