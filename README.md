# Perl::Critic

A Perl source code analyzer for VSCode

## Features

* Validates perl code on the fly

## Requirements

This extension requires Perl::Critic is installed
* `cpan install Perl::Critic` (cpan)
* `ppm install Perl-Critic` (ActivePerl)
* `sudo apt install libperl-critic-perl` (Ubuntu/Debian)
* `sudo yum install perl-Perl-Critic` (CentOS/RedHat)

## Extension Settings

This extension contributes the following settings:

* `perlcritic.executable`: path to perltidy executable (not required if perlcritic is already in your PATH)
* `perlcritic.severity`: severity level (**default: gentle**, options: 'gentle', 'stern', 'harsh', 'cruel' or 'brutal')
* `perlcritic.maxNumberOfProblems`: the maximum number of problems to show at any given time (default: 10)
* `perlcritic.additionalArguments`: any additional arguments for perlcritic
    * NOTE: arguments that change the output format could result in errors e.g:
        * --count
        * --verbose
        * --statistics-only
        * --list
        * --list-enabled
        * --list-themes
        * --profile-proto
        * -C
        * --pager
        * --doc
    * These arguments will be stripped out if added
    * However, they could result in errors if included in a perlcritic.cfg file

## Contribute

You are welcome to help make this extension better by reporting issues or opening pull requests at https://github.com/sfodje/perlcritic
